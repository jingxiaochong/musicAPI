require('dotenv').config()
const fs = require('fs')
const path = require('path')
const express = require('express')
const axios = require('axios')
const request = require('./util/request')
const songUrlV1 = require('./module/song_url_v1')
const packageJSON = require('./package.json')
const exec = require('child_process').exec
const cache = require('./util/apicache').middleware
const { cookieToJson } = require('./util/index')
const fileUpload = require('express-fileupload')
const decode = require('safe-decode-uri-component')
const logger = require('./util/logger.js')
const { APP_CONF } = require('./util/config.json')

const MUSIC_STREAM_LEVELS = new Set([
  'standard',
  'exhigh',
  'lossless',
  'hires',
  'jyeffect',
  'sky',
  'vivid',
  'jymaster',
])

function isAllowedMusicHost(hostname) {
  const normalizedHostname = hostname.toLowerCase()
  return (
    normalizedHostname === 'music.126.net' ||
    normalizedHostname.endsWith('.music.126.net')
  )
}

function createModuleRequest(req) {
  return (...params) => {
    const requestParams = [...params]
    const options = requestParams[2] || {}
    let ip = options.randomCNIP ? global.cnIp : req.ip

    if (ip && ip.startsWith('::ffff:')) {
      ip = ip.slice(7)
    }
    if (ip === '::1') {
      ip = global.cnIp
    }

    requestParams[2] = {
      ...options,
      ip,
    }

    return request(...requestParams)
  }
}

/**
 * The version check result.
 * @readonly
 * @enum {number}
 */
const VERSION_CHECK_RESULT = {
  FAILED: -1,
  NOT_LATEST: 0,
  LATEST: 1,
}

/**
 * @typedef {{
 *   identifier?: string,
 *   route: string,
 *   module: any
 * }} ModuleDefinition
 */

/**
 * @typedef {{
 *   port?: number,
 *   host?: string,
 *   checkVersion?: boolean,
 *   moduleDefs?: ModuleDefinition[]
 * }} NcmApiOptions
 */

/**
 * @typedef {{
 *   status: VERSION_CHECK_RESULT,
 *   ourVersion?: string,
 *   npmVersion?: string,
 * }} VersionCheckResult
 */

/**
 * @typedef {{
 *  server?: import('http').Server,
 * }} ExpressExtension
 */

/**
 * Get the module definitions dynamically.
 *
 * @param {string} modulesPath The path to modules (JS).
 * @param {Record<string, string>} [specificRoute] The specific route of specific modules.
 * @param {boolean} [doRequire] If true, require() the module directly.
 * Otherwise, print out the module path. Default to true.
 * @returns {Promise<ModuleDefinition[]>} The module definitions.
 *
 * @example getModuleDefinitions("./module", {"album_new.js": "/album/create"})
 */
async function getModulesDefinitions(
  modulesPath,
  specificRoute,
  doRequire = true,
) {
  const files = await fs.promises.readdir(modulesPath)
  const parseRoute = (/** @type {string} */ fileName) =>
    specificRoute && fileName in specificRoute
      ? specificRoute[fileName]
      : `/${fileName.replace(/\.js$/i, '').replace(/_/g, '/')}`

  const modules = files
    .reverse()
    .filter((file) => file.endsWith('.js'))
    .map((file) => {
      const identifier = file.split('.').shift()
      const route = parseRoute(file)
      const modulePath = path.join(modulesPath, file)
      const module = doRequire ? require(modulePath) : modulePath

      return { identifier, route, module }
    })

  return modules
}

/**
 * Check if the version of this API is latest.
 *
 * @returns {Promise<VersionCheckResult>} If true, this API is up-to-date;
 * otherwise, this API should be upgraded and you would
 * need to notify users to upgrade it manually.
 */
async function checkVersion() {
  return new Promise((resolve) => {
    exec('npm info NeteaseCloudMusicApiEnhanced version', (err, stdout) => {
      if (!err) {
        let version = stdout.trim()

        /**
         * @param {VERSION_CHECK_RESULT} status
         */
        const resolveStatus = (status) =>
          resolve({
            status,
            ourVersion: packageJSON.version,
            npmVersion: version,
          })

        resolveStatus(
          packageJSON.version < version
            ? VERSION_CHECK_RESULT.NOT_LATEST
            : VERSION_CHECK_RESULT.LATEST,
        )
      } else {
        resolve({
          status: VERSION_CHECK_RESULT.FAILED,
        })
      }
    })
  })
}

function parseCorsAllowOrigins(corsAllowOrigin) {
  if (!corsAllowOrigin) {
    return null
  }

  const origins = corsAllowOrigin
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  return origins.length > 0 ? origins : null
}

function getCorsAllowOrigin(allowOrigins, requestOrigin) {
  if (!allowOrigins) {
    return requestOrigin || '*'
  }

  if (allowOrigins.includes('*')) {
    return '*'
  }

  if (requestOrigin && allowOrigins.includes(requestOrigin)) {
    return requestOrigin
  }

  return null
}

function createConsoleSpinner(message = '启动中') {
  if (!process.stdout.isTTY) {
    return {
      stop() {},
    }
  }

  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let index = 0
  process.stdout.write(`${frames[index]} ${message}...`)
  const timer = setInterval(() => {
    index = (index + 1) % frames.length
    process.stdout.write(`\r${frames[index]} ${message}...`)
  }, 80)

  return {
    stop() {
      clearInterval(timer)
      process.stdout.write(`\r✔ ${message} 完成。\n`)
    },
  }
}

/**
 * Construct the server of NCM API.
 *
 * @param {ModuleDefinition[]} [moduleDefs] Customized module definitions [advanced]
 * @returns {Promise<import("express").Express>} The server instance.
 */
async function constructServer(moduleDefs) {
  const app = express()
  const { CORS_ALLOW_ORIGIN } = process.env
  const allowOrigins = parseCorsAllowOrigins(CORS_ALLOW_ORIGIN)
  app.set('trust proxy', true)

  /**
   * Serving static files
   */
  app.use(express.static(path.join(__dirname, 'public')))
  /**
   * CORS & Preflight request
   */
  app.use((req, res, next) => {
    if (req.path !== '/' && !req.path.includes('.')) {
      const corsAllowOrigin = getCorsAllowOrigin(
        allowOrigins,
        req.headers.origin,
      )
      const shouldSetVaryHeader = corsAllowOrigin && corsAllowOrigin !== '*'
      res.set({
        'Access-Control-Allow-Credentials': true,
        ...(corsAllowOrigin
          ? { 'Access-Control-Allow-Origin': corsAllowOrigin }
          : {}),
        ...(shouldSetVaryHeader ? { Vary: 'Origin' } : {}),
        'Access-Control-Allow-Headers': 'X-Requested-With,Content-Type',
        'Access-Control-Allow-Methods': 'PUT,POST,GET,DELETE,OPTIONS',
        'Content-Type': 'application/json; charset=utf-8',
      })
    }
    req.method === 'OPTIONS' ? res.status(204).end() : next()
  })

  /**
   * Cookie Parser
   */
  app.use((req, _, next) => {
    req.cookies = {}
    //;(req.headers.cookie || '').split(/\s*;\s*/).forEach((pair) => { //  Polynomial regular expression //
    ;(req.headers.cookie || '').split(/;\s+|(?<!\s)\s+$/g).forEach((pair) => {
      let crack = pair.indexOf('=')
      if (crack < 1 || crack == pair.length - 1) return
      req.cookies[decode(pair.slice(0, crack)).trim()] = decode(
        pair.slice(crack + 1),
      ).trim()
    })
    next()
  })

  /**
   * Relay NetEase audio through this server so clients that cannot reach the
   * NetEase CDN directly can still play a song. The upstream URL is resolved
   * by song ID and restricted to the NetEase music CDN.
   */
  app.get('/music/stream', async (req, res) => {
    const id = String(req.query.id || '').trim()
    const requestedLevel = String(req.query.level || 'standard').trim()
    const level = MUSIC_STREAM_LEVELS.has(requestedLevel)
      ? requestedLevel
      : 'standard'

    if (!/^\d+$/.test(id)) {
      res.status(400).send({
        code: 400,
        message: '缺少有效的歌曲 ID',
      })
      return
    }

    try {
      const moduleResponse = await songUrlV1(
        {
          id,
          level,
          encodeType: 'mp3',
          cookie: req.cookies,
        },
        createModuleRequest(req),
      )
      const song = moduleResponse.body?.data?.[0]

      if (!song?.url) {
        res.status(moduleResponse.status || 404).send({
          code: song?.code || moduleResponse.body?.code || 404,
          message: song?.message || '当前歌曲没有可用播放地址',
        })
        return
      }

      const mediaUrl = new URL(song.url)
      if (
        !['http:', 'https:'].includes(mediaUrl.protocol) ||
        !isAllowedMusicHost(mediaUrl.hostname)
      ) {
        res.status(502).send({
          code: 502,
          message: '播放地址不在允许的网易云 CDN 范围内',
        })
        return
      }

      const upstreamHeaders = {
        'User-Agent':
          req.get('User-Agent') ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: 'https://music.163.com/',
      }
      if (req.headers.range) {
        upstreamHeaders.Range = req.headers.range
      }
      if (req.headers['if-range']) {
        upstreamHeaders['If-Range'] = req.headers['if-range']
      }

      const upstream = await axios.get(mediaUrl.toString(), {
        responseType: 'stream',
        headers: upstreamHeaders,
        timeout: 30000,
        maxRedirects: 5,
        proxy: false,
        validateStatus: (status) => status === 200 || status === 206,
      })

      const forwardedHeaders = [
        'accept-ranges',
        'content-length',
        'content-range',
        'content-type',
        'etag',
        'last-modified',
      ]
      for (const header of forwardedHeaders) {
        const value = upstream.headers[header]
        if (value !== undefined) {
          res.setHeader(header, value)
        }
      }
      res.setHeader('Cache-Control', 'private, no-store')
      res.status(upstream.status)

      upstream.data.on('error', (error) => {
        logger.error(`Audio stream failed: ${id}`, error)
        res.destroy(error)
      })
      res.on('close', () => upstream.data.destroy())
      upstream.data.pipe(res)
    } catch (error) {
      logger.error(`Audio relay failed: ${id}`, error)
      if (!res.headersSent) {
        res.status(error.response?.status || 502).send({
          code: error.response?.status || 502,
          message: '音频中转失败',
        })
      } else {
        res.destroy(error)
      }
    }
  })

  /**
   * Body Parser and File Upload
   */
  const MAX_UPLOAD_SIZE_MB = 500
  const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024

  app.use(express.json({ limit: `${MAX_UPLOAD_SIZE_MB}mb` }))
  app.use(
    express.urlencoded({ extended: false, limit: `${MAX_UPLOAD_SIZE_MB}mb` }),
  )

  app.use(
    fileUpload({
      limits: {
        fileSize: MAX_UPLOAD_SIZE_BYTES,
      },
      useTempFiles: true,
      tempFileDir: require('os').tmpdir(),
      abortOnLimit: true,
      parseNested: true,
    }),
  )

  /**
   * Cache
   */
  app.use(cache('2 minutes', (_, res) => res.statusCode === 200))

  /**
   * Special Routers
   */
  const special = {
    'daily_signin.js': '/daily_signin',
    'fm_trash.js': '/fm_trash',
    'personal_fm.js': '/personal_fm',
  }

  /**
   * Load every modules in this directory
   */
  const moduleDefinitions =
    moduleDefs ||
    (await getModulesDefinitions(path.join(__dirname, 'module'), special))

  for (const moduleDef of moduleDefinitions) {
    // Register the route.
    app.all(moduleDef.route, async (req, res) => {
      ;[req.query, req.body].forEach((item) => {
        // item may be undefined (some environments / middlewares).
        // Guard access to avoid "Cannot read properties of undefined (reading 'cookie')".
        if (item && typeof item.cookie === 'string') {
          item.cookie = cookieToJson(decode(item.cookie))
        }
      })

      let query = Object.assign(
        {},
        { cookie: req.cookies },
        req.query,
        req.body,
        req.files,
      )

      try {
        let usedCrypto = ''
        const moduleResponse = await moduleDef.module(query, (...params) => {
          const obj = [...params]
          const options = obj[2] || {}
          usedCrypto = options.crypto || ''
          let ip = ''

          if (options.randomCNIP) {
            ip = global.cnIp
          } else {
            ip = req.ip

            if (ip.substring(0, 7) == '::ffff:') {
              ip = ip.substring(7)
            }
            if (ip == '::1') {
              ip = global.cnIp
            }
          }

          obj[2] = {
            ...options,
            ip,
          }

          return request(...obj)
        })
        const displayCrypto = usedCrypto || (APP_CONF.encrypt ? 'eapi' : 'api')
        logger.info(
          `Request Success: [${displayCrypto}] ${decode(req.originalUrl)}`,
        )

        // 夹带私货部分：如果开启了通用解锁，并且是获取歌曲URL的接口，则尝试解锁（如果需要的话）ヾ(≧▽≦*)o
        if (
          req.baseUrl === '/song/url/v1' &&
          process.env.ENABLE_GENERAL_UNBLOCK === 'true'
        ) {
          const song = moduleResponse.body.data[0]
          if (
            song.freeTrialInfo !== null ||
            !song.url ||
            [1, 4].includes(song.fee)
          ) {
            const {
              matchID,
            } = require('@neteasecloudmusicapienhanced/unblockmusic-utils')
            logger.info('Starting unblock(uses general unblock):', req.query.id)
            const result = await matchID(req.query.id)
            song.url = result.data.url
            song.freeTrialInfo = null
            logger.info('Unblock success! url:', song.url)
          }
          if (song.url && song.url.includes('kuwo')) {
            const proxy = process.env.PROXY_URL
            const useProxy = process.env.ENABLE_PROXY || 'false'
            if (useProxy === 'true' && proxy) {
              song.proxyUrl = proxy + song.url
            }
          }
        }

        const cookies = moduleResponse.cookie
        if (!query.noCookie) {
          if (Array.isArray(cookies) && cookies.length > 0) {
            if (req.protocol === 'https') {
              // Try to fix CORS SameSite Problem
              res.append(
                'Set-Cookie',
                cookies.map((cookie) => {
                  return cookie + '; SameSite=None; Secure'
                }),
              )
            } else {
              res.append('Set-Cookie', cookies)
            }
          }
        }
        if (moduleResponse.redirectUrl) {
          res.redirect(moduleResponse.status || 302, moduleResponse.redirectUrl)
          return
        }

        res.status(moduleResponse.status).send(moduleResponse.body)
      } catch (/** @type {*} */ moduleResponse) {
        logger.error(`${decode(req.originalUrl)}`, {
          status: moduleResponse.status,
          body: moduleResponse.body,
        })
        if (!moduleResponse.body) {
          res.status(404).send({
            code: 404,
            data: null,
            msg: 'Not Found',
          })
          return
        }
        if (moduleResponse.body.code == '301')
          moduleResponse.body.msg = '需要登录'
        if (!query.noCookie) {
          res.append('Set-Cookie', moduleResponse.cookie)
        }

        res.status(moduleResponse.status).send(moduleResponse.body)
      }
    })
  }

  return app
}

/**
 * Serve the NCM API.
 * @param {NcmApiOptions} options
 * @returns {Promise<import('express').Express & ExpressExtension>}
 */
async function serveNcmApi(options) {
  const port = Number(options.port || process.env.PORT || '3000')
  const host = options.host || process.env.HOST || ''

  const spinner = createConsoleSpinner('服务启动中')

  const checkVersionSubmission =
    options.checkVersion &&
    checkVersion().then(({ npmVersion, ourVersion, status }) => {
      if (status == VERSION_CHECK_RESULT.NOT_LATEST) {
        logger.warn(
          `最新版本: ${npmVersion}, 当前版本: ${ourVersion}, 请及时更新`,
        )
      }
    })
  const constructServerSubmission = constructServer(options.moduleDefs)

  const [_, app] = await Promise.all([
    checkVersionSubmission,
    constructServerSubmission,
  ])

  spinner.stop()

  /** @type {import('express').Express & ExpressExtension} */
  const appExt = app
  appExt.server = app.listen(port, host, () => {
    console.log(`
  ╔═╗╔═╗╦    ╔═╗╔╗╔╦ ╦╔═╗╔╗╔╔═╗╔═╗╔╦╗
  ╠═╣╠═╝║    ║╣ ║║║╠═╣╠═╣║║║║  ║╣  ║║
  ╩ ╩╩  ╩    ╚═╝╝╚╝╩ ╩╩ ╩╝╚╝╚═╝╚═╝═╩╝
    `)
    logger.info(
      `Server started successfully @ http://${host ? host : 'localhost'}:${port}`,
    )
  })

  return appExt
}

module.exports = {
  serveNcmApi,
  getModulesDefinitions,
}
