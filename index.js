const yargs = require('yargs');
const Linkloader = require('./src/linkloader.js');

const args = yargs
    .scriptName('linkloader')
    .locale('en')
    .option('concurrent', {
        alias: 'c',
        default: 4,
        type: 'number'
    })
    .option('file', {
        alias: 'f',
        default: 'urls.txt',
        type: 'string',
        // coerce: file => readFile(file)
    })
    .option('dist', {
        alias: 'd',
        default: 'dist',
        type: 'string'
    })
	.option('type', {
		alias: 't',
		type: 'string'
	})
	.option('ua', {
		type: 'string'
	})
    .option('cookie', {
        type: 'string'
    })
    .option('reverse', {
        alias: 'r',
        type: 'boolean',
        default: false
    })
    .option('clear', {
        type: 'boolean',
        default: false
    })
    .option('names', {
        type: 'boolean',
        default: false
    })
    .option('skip', {
        type: 'boolean',
        default: false
    })
    .describe('concurrent', 'amount of concurrent requests')
    .describe('file', 'file to read urls from')
    .describe('dist', 'the directory to write files to')
    .epilogue('May you use this tool and swear by oath not to abuse it, do not be evil.')
    .argv;

if (args.type) {
	args.dist = args.type;
	args.file = args.type + '.txt';
}

const linkloader = new Linkloader(args);
linkloader.start();
