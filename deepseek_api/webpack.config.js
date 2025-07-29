const path = require('path');
const webpack = require('webpack');

module.exports = {
	 target: 'node', 
	 entry: './app.js',
	 plugins: [
		new webpack.IgnorePlugin({  resourceRegExp: /^pg-native$|^cloudflare:sockets$/,})
	  ],
	  output: {
		path: path.resolve(__dirname, 'dist'),
		filename: 'index_bundle.js'
  }
}