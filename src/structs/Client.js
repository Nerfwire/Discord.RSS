const Discord = require('discord.js')
const EventEmitter = require('events')
const listeners = require('../util/listeners.js')
const maintenance = require('../maintenance/index.js')
const ipc = require('../util/ipc.js')
const Profile = require('./db/Profile.js')
const initialize = require('../initialization/index.js')
const getConfig = require('../config.js').get
const createLogger = require('../util/logger/create.js')
const connectDb = require('../util/connectDatabase.js')
const { once } = require('events')
const devLevels = require('../util/devLevels.js')
const dumpHeap = require('../util/dumpHeap.js')
const DeliveryPipeline = require('./DeliveryPipeline.js')

const STATES = {
  STOPPED: 'STOPPED',
  STARTING: 'STARTING',
  READY: 'READY'
}
/**
 * @type {import('discord.js').ClientOptions}
 */
const CLIENT_OPTIONS = {
  /**
   * Allow minimal caching for message reactions/pagination
   * handling. After 10 messages after the initial
   * paginated embed, the pagination will stop working
   */
  messageCacheMaxSize: 10,
  ws: {
    intents: [
      'GUILDS',
      'GUILD_MESSAGES',
      'GUILD_MESSAGE_REACTIONS'
    ]
  }
}

class Client extends EventEmitter {
  constructor () {
    super()
    this.STATES = STATES
    this.state = STATES.STOPPED
    /**
     * @type {import('./DeliveryPipeline.js')}
     */
    this.deliveryPipeline = undefined
    /**
     * @type {import('pino').Logger}
     */
    this.log = undefined
  }

  async login (token) {
    if (this.bot) {
      return this.log.warn('Cannot login when already logged in')
    }
    if (typeof token !== 'string') {
      throw new TypeError('Argument must a string')
    }
    const client = new Discord.Client(CLIENT_OPTIONS)
    try {
      this.deliveryPipeline = new DeliveryPipeline(client)
      this.log = createLogger('-')
      await client.login(token)
      this.log = createLogger(client.shard.ids[0].toString())
      this.bot = client
      this.shardID = client.shard.ids[0]
      this.listenToShardedEvents(client)
      if (!client.readyAt) {
        await once(client, 'ready')
        this._setup()
      } else {
        this._setup()
      }
    } catch (err) {
      this.log.error(err, 'Discord.RSS failed to start')
      ipc.send(ipc.TYPES.KILL)
    }
  }

  async connectToDatabase () {
    const config = getConfig()
    const mongo = await connectDb(config.database.uri, config.database.connection)
    mongo.on('error', (error) => {
      this.log.fatal(error, 'MongoDB connection error')
      this.kill()
    })
    mongo.on('disconnected', () => {
      this.log.error('MongoDB disconnected')
      this.stop()
    })
    mongo.on('reconnected', () => {
      this.log.info('MongoDB reconnected')
      this.restart()
    })
    return mongo
  }

  _setup () {
    const bot = this.bot
    bot.on('error', err => {
      this.log.warn('Websocket error', err)
      const config = getConfig()
      if (config.bot.exitOnSocketIssues === true) {
        this.log.info('Stopping all processes due to config.bot.exitOnSocketIssues')
        this.kill()
      } else {
        this.stop()
      }
    })
    bot.on('debug', info => this.log.debug(info))
    bot.on('resume', () => {
      this.log.info('Websocket resumed')
      this.start()
    })
    bot.on('disconnect', () => {
      this.log.warn(`SH ${this.shardID} Websocket disconnected`)
      const config = getConfig()
      if (config.bot.exitOnSocketIssues === true) {
        this.log.general.info('Stopping all processes due to config.bot.exitOnSocketIssues')
        ipc.send(ipc.TYPES.KILL)
      } else {
        this.stop()
      }
    })
    if (devLevels.dumpHeap()) {
      this.setupHeapDumps()
    }
    this.log.info(`Discord.RSS has logged in as "${bot.user.username}" (ID ${bot.user.id})`)
    ipc.send(ipc.TYPES.SHARD_READY, {
      guildIds: bot.guilds.cache.keyArray(),
      channelIds: bot.channels.cache.keyArray()
    })
  }

  setupHeapDumps () {
    // Every 10 minutes
    const prefix = `s${this.bot.shard.ids[0]}`
    dumpHeap(prefix)
    setInterval(() => {
      dumpHeap(prefix)
    }, 1000 * 60 * 15)
  }

  listenToShardedEvents (bot) {
    process.on('message', async message => {
      if (!ipc.isValid(message)) {
        return
      }
      try {
        switch (message.type) {
          case ipc.TYPES.START_INIT: {
            const data = message.data
            if (data.setPresence) {
              const config = getConfig()
              bot.user.setPresence({
                status: config.bot.status,
                activity: {
                  name: config.bot.activityName,
                  type: config.bot.activityType,
                  url: config.bot.streamActivityURL || undefined
                }
              }).catch(err => this.log.warn({
                error: err
              }, 'Failed to set presence'))
            }
            this.start()
            break
          }
          case ipc.TYPES.NEW_ARTICLE:
            this.onNewArticle(message.data.newArticle, message.data.debug)
            break
          case ipc.TYPES.FINISHED_INIT:
            break
          case ipc.TYPES.SEND_USER_ALERT:
            this.sendUserAlert(message.data.channel, message.data.message)
              .catch(err => this.log.warn(`Failed to send inter-process alert to channel ${message.data.channel}`, err))
        }
      } catch (err) {
        this.log.error(err, 'client')
      }
    })
  }

  async onNewArticle (newArticle, debug) {
    try {
      await this.deliveryPipeline.deliver(newArticle, debug)
    } catch (err) {
      this.log.error(err, 'Delivery pipeline')
    }
  }

  async sendChannelMessage (channelID, message) {
    const channel = this.bot.channels.cache.get(channelID)
    if (!channel) {
      return
    }
    /**
     * @type {import('discord.js').GuildMember}
     */
    const guildMeMember = channel.guild.me
    if (!guildMeMember.permissionsIn(channel).has(Discord.Permissions.FLAGS.SEND_MESSAGES)) {
      this.log.warn({
        channel,
        string: message
      }, 'Failed to send Client message to channel')
      return
    }
    channel.send(message)
  }

  async sendUserAlert (channelID, message) {
    const fetchedChannel = this.bot.channels.cache.get(channelID)
    if (!fetchedChannel) {
      return
    }
    const alertMessage = `**ALERT**\n\n${message}`
    try {
      const profile = await Profile.get(fetchedChannel.guild.id)
      if (!profile) {
        return this.sendChannelMessage(channelID, alertMessage)
      }
      const alertTo = profile.alert
      for (const id of alertTo) {
        const user = await this.bot.users.fetch(id, false)
        if (user) {
          await user.send(alertMessage)
        }
      }
    } catch (err) {
      this.log.warn({
        error: err
      }, `Failed to send user alert to channel ${channelID}`)
      return this.sendChannelMessage(alertMessage)
    }
  }

  async start () {
    if (this.state === STATES.STARTING || this.state === STATES.READY) {
      return this.log.warn(`Ignoring start command because of ${this.state} state`)
    }
    const config = getConfig()
    const disableCommands = devLevels.disableCommands() || !config.bot.enableCommands
    this.state = STATES.STARTING
    try {
      if ((this.mongo && this.mongo.readyState !== 1) || Profile.isMongoDatabase) {
        this.mongo = await this.connectToDatabase()
      }
      await initialize.setupModels(this.mongo)
      await initialize.setupCommands(disableCommands)
      const uri = config.database.uri
      this.log.info(`Database URI detected as a ${uri.startsWith('mongo') ? 'MongoDB URI' : 'folder URI'}`)
      await maintenance.pruneWithBot(this.bot)
      this.state = STATES.READY
      await initialize.setupRateLimiters(this.bot)
      this.log.info(`Commands have been ${config.bot.enableCommands ? 'enabled' : 'disabled'}.`)
      ipc.send(ipc.TYPES.INIT_COMPLETE)
      listeners.createManagers(this.bot, disableCommands)
      this.emit('finishInit')
    } catch (err) {
      this.log.error(err, 'Client start')
    }
  }

  kill () {
    ipc.send(ipc.TYPES.KILL)
  }

  stop () {
    if (this.state === STATES.STARTING || this.state === STATES.STOPPED) {
      return this.log.warn(`Ignoring stop command because of ${this.state} state`)
    }
    this.log.info('Discord.RSS has received stop command')
    clearInterval(this.maintenance)
    listeners.disableAll(this.bot)
    this.state = STATES.STOPPED
    ipc.send(ipc.TYPES.SHARD_STOPPED)
  }

  async restart () {
    if (this.state === STATES.STARTING) {
      return this.log.warn(`Ignoring restart command because of ${this.state} state`)
    }
    if (this.state === STATES.READY) {
      this.stop()
    }
    return this.start()
  }
}

module.exports = Client
