#!/usr/bin/env node
const puppeteer = require('puppeteer');
const { getPuppeteerChromeInfo } = require('../lib/wa-chrome-runtime');

const info = getPuppeteerChromeInfo(puppeteer);

console.log(JSON.stringify(info, null, 2));
