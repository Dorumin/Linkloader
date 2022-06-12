const fs = require('fs');
const got = require('got');
const path = require('path');
const { promisify } = require('util');
const stream = require('stream');
// const readline = require('readline');
const filenamify = require('filenamify');
const stringWidth = require('string-width');

const pipeline = promisify(stream.pipeline);
const makeDir = promisify(fs.mkdir);
const readDir = promisify(fs.readdir);
const readFile = promisify(fs.readFile);
const deleteFile = promisify(fs.unlink);

const REFRESH_RATE = 30;

class Download {
    constructor(line, output, loader) {
        this.line = line;
        this.loader = loader;
        this.url = this.getUrl(line);
        this.name = this.getFileName();
        this.filePath = path.join(output, this.name);
        this.started = false;
        this.errored = false;
        this.retries = 0;
        this.progress = 0;
        this.finished = false;
        this.stream = null;
        this.promise = new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });
    }

    getUrl(line) {
        if (this.loader.names) {
            return line.split(' ')[0];
        } else {
            return line;
        }
    }

    getFileName() {
        if (this.loader.names) {
            const wantedName = this.line.split(' ').slice(1).join(' ');

            return this.loader.requestName(filenamify(wantedName));
        }

        const index = this.url.lastIndexOf('/');
        const slice = this.url.slice(index + 1);
        const qIndex = slice.indexOf('?');
        const name = qIndex === -1
            ? slice
            : slice.slice(0, qIndex);
        const decoded = decodeURIComponent(name);

        let output = decoded;

        // Long filenames
        if (decoded.length > 200) {
            const extIndex = decoded.lastIndexOf('.');
            const name = extIndex === -1
                ? decoded
                : decoded.slice(0, extIndex);
            const ext = extIndex === -1
                ? ''
                : decoded.slice(extIndex + 1);

            output = name.slice(0, 200) + '.' + ext;
        }

        return this.loader.requestName(output);
    }

    then(fn, cb) {
        return this.promise.then(fn, cb);
    }

    getHeaders() {
        const headers = {};

        if (this.loader.userAgent) {
            headers['User-Agent'] = this.loader.userAgent;
        }

        if (this.loader.cookie) {
            headers['Cookie'] = this.loader.cookie;
        }

        return headers;
    }

    async start() {
        this.startTime = Date.now();
        this.started = true;
        this.errored = false;

        try {
            await pipeline(
                got(this.url, {
                    isStream: true,
                    timeout: 1000 * 60 * 30,
                    headers: this.getHeaders()
                }).on('downloadProgress', progress => {
                    this.progress = progress.percent;
                }),
                fs.createWriteStream(this.filePath)
            );
        } catch(e) {
            this.started = false;
            this.errored = true;
            this.retries++;

            await deleteFile(this.filePath);

            throw e;
        }

        this.finished = true;
        this._resolve();
    }
}

class Linkloader {
    constructor(args) {
        this.concurrencyLimit = args.concurrent;
        this.clear = args.clear;
        this.names = args.names;
        this.input = args.file;
        this.output = args.dist;
        this.reverse = args.reverse;
        this.userAgent = args.ua;
        this.cookie = args.cookie;

        this.finished = 0;
        this.total = 0;
        this.retries = 0;
        this.downloads = [];
        this.seenNames = {};

        // Rendering
        this.displayed = [];
        this.logs = [];

        this.stdin = process.stdin;
        this.stdout = process.stdout;
        // this.rl = readline.createInterface({
        //     input: this.stdin,
        //     output: this.stdout
        // });
    }

    requestName(wantedName) {
        if (this.seenNames.hasOwnProperty(wantedName)) {
            this.seenNames[wantedName]++;

            const times = this.seenNames[wantedName];
            const parts = wantedName.split('.');

            if (parts.length === 1) {
                return `${parts[0]} (${times})`;
            } else {
                const ext = parts.pop();
                return `${parts.join('.')} (${times}).${ext}`;
            }
        } else {
            this.seenNames[wantedName] = 1;

            return wantedName;
        }
    }

    async prepOutput() {
        try {
            await makeDir(this.output, { recursive: true });
        } catch(e) {}
    }

    async clearDir(dirPath) {
        const children = await readDir(dirPath);

        await Promise.all(
            children
                .map(child => path.join(dirPath, child))
                .map(childPath => deleteFile(childPath))
        );
    }

    async readInput() {
        const contents = await readFile(this.input, { encoding: 'utf8' });
        const urls = contents.split('\n').map(line => line.trim()).filter(Boolean);

        if (this.reverse) {
            urls.reverse();
        }

        this.downloads = urls.map(url => new Download(url, this.output, this));
        this.total = urls.length;
    }

    async start() {
        this.startDrawing();

        await this.prepOutput();

        if (this.clear) {
            await this.clearDir(this.output);
        }

        await this.readInput();
        await this.saveAll();

        this.stopDrawing();
    }

    wait(ms) {
        return new Promise(res => setTimeout(res, ms));
    }

    async saveAll() {
        const iterations = Math.min(this.concurrencyLimit, this.downloads.length);
        for (let i = 0; i < iterations; i++) {
            const download = this.downloads[i];

            this.startDownload(download);
        }

        await Promise.all(this.downloads);
    }

    async startDownload(download) {
        // console.log(`Starting download for ${download.name}`);

        let i = 0;
        while (i < this.displayed.length) {
            const displayed = this.displayed[i];

            if (displayed.finished || displayed.errored) break;

            i++;
        }

        this.displayed[i] = download;

        try {
            await download.start();
            this.finished++;
        } catch(e) {
            this.retries++;

            const index = this.downloads.indexOf(download);
            this.downloads.splice(index, 1);

            if (download.retries < 10) {
                this.downloads.push(download);
            } else {
                this.log(`Gave up after 10 tries:\n${download.url}`);
                download._resolve();
            }
        }

        for (let i = 0; i < this.downloads.length; i++) {
            const dl = this.downloads[i];

            if (!dl.finished && !dl.started) {
                this.startDownload(dl);
                break;
            }
        }
    }

    log(message) {
        this.logs.push(message);
    }

    hideCursor() {
        this.stdout.write('\x1B[?25l');
    }

    showCursor() {
        this.stdout.write('\x1B[?25h');
    }

    clearScreen() {
        return '\x1B[2J';
    }

    moveCursor(x, y) {
        return `\x1B[${x};${y}H`
    }

    resetCursorPosition() {
        return this.moveCursor(0, 0);
    }

    startDrawing() {
        this.hideCursor();
        this.schedule('drawTimeout', this.draw.bind(this), REFRESH_RATE);
    }

    stopDrawing() {
        clearTimeout(this.drawTimeout);
        this.showCursor();
        // this.rl.close();
    }

    schedule(label, cb, delay) {
        if (this[label]) return;

        this[label] = setTimeout(() => {
            delete this[label];
            cb();
        }, delay);
    }

    pad(n, digits = 2, char = '0') {
        return (new Array(digits).join(char) + n).slice(-digits);
    }

    formatDownload(dl, min, max) {
        let line = dl.name.padEnd(min, ' ');

        const elapsedMs = Date.now() - dl.startTime;
        const elapsedS = Math.floor(elapsedMs / 1000);
        const elapsedM = Math.floor(elapsedS / 60);
        const elapsed = `${this.pad(elapsedM)}:${this.pad(elapsedS % 60)}`;
        const progress = `${Math.floor(dl.progress * 100)}%`;
        const statuses = [elapsed, progress];

        let status = '';

        if (dl.retries > 0) {
            status = `${dl.retries}`;
        }

        if (dl.finished) {
            status = 'DONE';
        }

        if (status !== '') {
            statuses.push(status);
        }

        let statusStr = '';

        for (const status of statuses) {
            statusStr += ` [${status}]`;
        }

        if (line.length + statusStr.length > max) {
            // TODO: Consider using the single-char ellipsis
            line = line.slice(0, max - statusStr.length - 3) + '...';
        }


        line += statusStr;

        return line + '\n';
    }

    getMaxLen() {
        let len = 32;

        for (const dl of this.displayed) {
            const width = stringWidth(dl.name);

            if (width > len) {
                len = width;
            }
        }

        return len;
    }

    formatDownloads() {
        const max = process.stdout.columns;
        const len = this.getMaxLen();
        const buffer = [];
        for (const dl of this.displayed) {
            buffer.push(this.formatDownload(dl, len, max));
        }

        return buffer.join('');
    }

    draw() {
        this.render(
            `Linkloader running with ${this.total} target files, ${this.finished} finished, ${this.retries} retries and ${this.concurrencyLimit} concurrent downloads\n` +
            this.formatDownloads() + this.logs.join('\n')
        );

        this.schedule('drawTimeout', this.draw.bind(this), REFRESH_RATE);
    }

    render(text) {
        // this.stdout.cursorTo(0, 0);
        // this.stdout.clearScreenDown();
        // this.clearScreen();
        this.stdout.write(`${this.clearScreen()}${this.resetCursorPosition()}${text}`);
    }
}

module.exports = Linkloader;
