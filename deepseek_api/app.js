var express = require('express');
var cors = require('cors');
var axios = require('axios');
const { Pool } = require('pg');
bodyParser = require('body-parser');
var app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json())
app.use(cors());

async function getpool(struct) {
	let pool = new Pool({
		user: struct.user_bd,
		host: struct.server_bd,
		database: struct.name_bd,
		password: struct.password_bd,
		port: struct.port_bd
	});

	await pool.connect()

	return pool
}

app.post('/deepseek/api/status', async function (req, responce) {

	const pool = await getpool(req.body)
	let id_message = req.body.id_message

	// собираю неотправленные клиенту сообщения
	let query =
		`SELECT id, text, last 
		FROM messages 
		WHERE id_message = $1 and send = false`;

	let res = await pool.query(query, [id_message]);

	rows = res.rows;
	masid = []
	rows.forEach(element => {
		masid.push(element.id)
	});

	// помечаю отправленными
	query =
		`UPDATE messages SET send = true  
		WHERE id = ANY($1)`;

	await pool.query(query, [masid])

	responce.status(200).send(JSON.stringify(rows))
});

app.post('/deepseek/api/chat', async function (req, responce) {

	const pool = await getpool(req.body)
	let id_user = req.body.id_user
	let message = req.body.message
	
	// собираю контекст для ИИ. Сначала некие служебные сообщения для общей настройки поведения
	// потом уже историю переписок
	let query =
		`SELECT 'system' as role, text as content 
		FROM public.system_message
					
		union all	
					
		SELECT role, content 
		FROM history WHERE id_user = $1`;

	const res = await pool.query(query, [id_user]);

	let messages = res.rows;
	messages.push(
		{
			"role": "user",
			"content": message
		})

	await saveToSQL_history(id_user, 'user', message, pool)
	await chat_deepseek(responce, messages, id_user, pool, req.body.url, req.body.token)

});

app.listen(process.env.PORT || 665, async function () {


});


async function chat_deepseek(GETresponce, messages, id_user, pool, url, token) {

	var myHeaders = new Headers();
	myHeaders.append("Content-Type", "application/json");
	myHeaders.append("Authorization", token);

	var raw = JSON.stringify({
		"model": "deepseek-chat",
		"stream": true,
		"messages": messages
	});

	var requestOptions = {
		method: 'POST',
		headers: myHeaders,
		body: raw,
		redirect: 'follow'
	};

	const response = await fetch(url, requestOptions);
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8");
	const len = 200

	let all_text = ''
	let current_text = ''
	let id_message = ''
	let SetResponce = true

	while (true) {
		const { value, done } = await reader.read();
		if (done) {

			// сохраню текущую порцию ответа
			await saveToSQL_messages(id_message, current_text, 1, id_user, pool)

			// сохраню весь ответ ИИ для контекста
			await saveToSQL_history(id_user, 'assistant', all_text, pool)

			// если это тест и некуда отсылать ответ, то завершу процесс вообще
			if (GETresponce == null) { process.exit(); }
			break
		}

		let text_value = decoder.decode(value)
		let it_query = false

		// считываю очередную порцию ответа		
		if (!text_value.includes('[DONE]')) {
			let mas_text = text_value.split('\n').filter(element => element)

			for (var index in mas_text) {
				let obj = JSON.parse(mas_text[index].replace('data:', ''))

				if (obj.choices == undefined) {
					// какая-то ошибка, нет частей сообщения
					await saveToSQL_messages(id_message, obj.error.message, 1, id_user, pool)
					break
				}

				obj.choices.forEach(element => {
					current_text += element.delta.content
					// запрос выделяется символом ```. Когда он встречается, жду второго такого, это окончание запроса
					if (it_query) {
						if (current_text.lastIndexOf("```") != current_text.indexOf("```")) {
							it_query = false
						}
					}
					else if (!it_query && current_text.search("```") != -1) {
						it_query = true
					}

					all_text += element.delta.content
				});

				if (SetResponce) {
					// сразу отсылаю id сообщения, что бы не ждать окончания ответа
					id_message = obj.id
					SetResponce = false
					if (GETresponce != null)
						GETresponce.status(200).send(obj.id)
				}
			}
		}

		// обрезка текста под порции, что бы можно было нормально выводить.
		// если текст больше определенной длины, то ищется ближайший конец предложения и текст по нему обрезается
		// ограничение на сообщение в системе взаимодействия 4000 символов, но там используется форматированный документ
		// из-за него нужно резать ограничение.
		if ((current_text.length > len && !it_query) || (it_query && current_text.length > 2000)) {

			let slice = current_text.slice(len)
			let search = /(! |\. |\? |\t)/.exec(slice)

			if (search != null) {
				let text_token = current_text.slice(0, len + search.index + 1).trim()
				current_text = current_text.slice(len + search.index + 1).trim()

				// сохраню порцию ответа от ИИ
				await saveToSQL_messages(id_message, text_token, 0, id_user, pool)
			}

		}
	}
}

async function saveToSQL_messages(id, text, last, id_user, pool) {

	let query =
		`INSERT INTO messages 
		(id_message, text, last, id_user) VALUES ($1, $2, $3, $4);`;

	await pool.query(query, [id, text, last, id_user]);

}

async function saveToSQL_history(id_user, role, content, pool) {

	let query =
		`INSERT INTO history
		(id_user, role, content, date) VALUES ($1, $2, $3, $4);`;

	let res = await pool.query(query, [id_user, role, content, new Date()]);
}
