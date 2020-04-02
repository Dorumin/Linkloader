const fs = require('fs');
const got = require('got');
const path = require('path');
const util = require('util');
const yargs = require('yargs');
const stream = require('stream');

const pipeline = util.promisify(stream.pipeline);
const makeDir = util.promisify(fs.mkdir);
const readDir = util.promisify(fs.readdir);
const readFile = util.promisify(fs.readFile);
const deleteFile = util.promisify(fs.unlink);

const args = yargs
    .scriptName('linkloader')
    .locale('en')
    .option('concurrent', {
        alias: 'c',
        default: 20,
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
    .describe('concurrent', 'amount of concurrent requests')
    .describe('file', 'file to read urls from')
    .describe('dist', 'the directory to write files to')
    .epilogue('May you use this tool and swear by oath not to abuse it, do not be evil.')
    .argv;

const files = [];

const clearDir = async (dirPath) => {
    try {
        await makeDir(dirPath);
    } catch(e) {}

    const children = await readDir(dirPath);

    await Promise.all(
        children
            .map(child => path.join(dirPath, child))
            .map(childPath => deleteFile(childPath))
    );
};

// Execute `fn` in parallel for at max `concurrent` concurrently executing calls over `iter`
// Very useful when combined with async iterators, `async function*`
// Wait, *checks notes*, it only works with async iterators, regular ones throw
const parallelIter = async (iter, concurrent, fn) => {
    const cb = async ({ value, done }) => {
        if (done) return;
        await fn(value);
        iter.next().then(cb);
    };

    while (concurrent--) {
        iter.next().then(cb);
    }
};

const allUrls = async function*(filePath) {
    const contents = await readFile(filePath),
    lines = contents.toString().split('\n');

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed) {
            const urls = trimmed.match(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g);

            if (urls) {
                for (const url of urls) {
                    yield url;
                }
            }
        }
    }
};

const saveUrl = async (url, dist) => {
    const wantedName = url.split('/').pop().split('?')[0],
    filePath = await getPath(dist, wantedName);

    console.log(`${filePath}`);

    let times = 1;
    const interval = setInterval(() => {
        console.log(`Download is taking a while... (${times++}) ${url}`);
    }, 30000);

    try {
        await pipeline(
            got(url, { isStream: true }),
            fs.createWriteStream(filePath)
        );
        clearInterval(interval);
    } catch(e) {
        console.log(`
            Failed while saving.
            URL: ${url}
            Path: ${filePath}
            Error: ${e}
        `);
        clearInterval(interval);
        await deleteFile(filePath);
    }
};

const getPath = async function(dirPath, name) {
    let result = name,
    split = name.split('.'),
    ext = split.pop(),
    start = split.join('.'),
    i = 1;

    while (files.includes(result)) {
        result = `${start}-${i++}.${ext}`;
    }

    files.push(result);

    return path.join(dirPath, result);
};

(async () => {
    console.log(args);

    console.time('clearing');
    await clearDir(args.dist);
    console.timeEnd('clearing');

    parallelIter(
        allUrls(args.file),
        args.concurrent,
        url => saveUrl(url, args.dist)
    );
})();
