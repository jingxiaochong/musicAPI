#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const tmpPath = require('os').tmpdir()

async function start() {
  // 检测是否存在 anonymous_token 文件,没有则生成
  if (!fs.existsSync(path.resolve(tmpPath, 'anonymous_token'))) {
    fs.writeFileSync(path.resolve(tmpPath, 'anonymous_token'), '', 'utf-8')
  }
  // 启动时更新 anonymous_token。不要让上游网络/DNS 波动阻塞本地服务监听。
  const generateConfig = require('./generateConfig')
  const configPromise = generateConfig().catch((error) => {
    console.log('上游初始化失败，服务继续启动:', error.message)
  })

  await require('./server').serveNcmApi({
    checkVersion: process.env.CHECK_VERSION === 'true',
  })

  await configPromise
}
start()
