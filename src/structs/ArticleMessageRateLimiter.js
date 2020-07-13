const GeneralStats = require('../models/GeneralStats.js')
const Supporter = require('./db/Supporter.js')
const configuration = require('../config.js')
const createLogger = require('../util/logger/create.js')

class ArticleRateLimiter {
  /**
   * @param {string} channelID
   * @param {boolean} increased
   */
  constructor (channelID, increased) {
    const config = configuration.get()
    const refreshRateMinutes = config.feeds.refreshRateMinutes
    const articlesLimit = config.feeds.articleRateLimit
    this.channelID = channelID
    this.articlesLimit = increased ? articlesLimit * 5 : articlesLimit
    this.articlesRemaining = this.articlesLimit
    if (this.articlesLimit !== 0) {
      this.timer = setInterval(() => {
        this.articlesRemaining = this.articlesLimit
      }, 1000 * 60 * refreshRateMinutes)
    }
  }

  static async updateArticlesSent () {
    if (this.sent === 0 || !Supporter.isMongoDatabase) {
      return
    }
    /**
     * @type {import('mongoose').Document}
     */
    const found = await GeneralStats.Model.findById(GeneralStats.TYPES.ARTICLES_SENT)
    if (!found) {
      const stat = new GeneralStats.Model({
        _id: GeneralStats.TYPES.ARTICLES_SENT,
        data: ArticleRateLimiter.sent
      })
      await stat.save()
    } else {
      await found.updateOne({
        $inc: {
          data: ArticleRateLimiter.sent
        }
      })
    }
    this.sent = 0
  }

  static async updateArticlesBlocked () {
    if (this.blocked === 0 || !Supporter.isMongoDatabase) {
      return
    }
    /**
     * @type {import('mongoose').Document}
     */
    const found = await GeneralStats.Model.findById(GeneralStats.TYPES.ARTICLES_BLOCKED)
    if (!found) {
      const stat = new GeneralStats.Model({
        _id: GeneralStats.TYPES.ARTICLES_BLOCKED,
        data: ArticleRateLimiter.blocked
      })
      await stat.save()
    } else {
      await found.updateOne({
        $inc: {
          data: ArticleRateLimiter.blocked
        }
      })
    }
    this.blocked = 0
  }

  /**
   * @param {string} channelID
   * @param {boolean} isSupporterGuild
   */
  static create (channelID, isSupporterGuild) {
    const highLimit = Supporter.enabled ? isSupporterGuild : true
    const limiter = new ArticleRateLimiter(channelID, highLimit)
    this.limiters.set(channelID, limiter)
    return limiter
  }

  static hasLimiter (channelID) {
    return this.limiters.has(channelID)
  }

  static getLimiter (channelID) {
    if (!this.hasLimiter(channelID)) {
      return this.create(channelID)
    } else {
      return this.limiters.get(channelID)
    }
  }

  /**
   * @param {import('../structs/ArticleMessage.js')} articleMessage
   * @param {import('discord.js').Client} bot
   */
  static async enqueue (articleMessage, bot) {
    const channel = articleMessage.getChannel(bot)
    if (!channel) {
      throw new Error('Missing channel for ArticleMessageRateLimiter enqueue')
    }
    const channelID = channel.id
    const articleLimiter = ArticleRateLimiter.getLimiter(channelID)
    if (articleLimiter.isAtLimit()) {
      ++ArticleRateLimiter.blocked
      throw new Error('Rate limited article')
    }
    ++ArticleRateLimiter.sent
    await articleLimiter.send(articleMessage, bot)
  }

  isAtLimit () {
    if (this.articlesLimit === 0) {
      return false
    } else {
      return this.articlesRemaining === 0
    }
  }

  /**
   * @param {import('./ArticleMessage.js')} articleMessage
   * @param {import('discord.js').Client} bot
   */
  async send (articleMessage, bot) {
    --this.articlesRemaining
    const sent = await articleMessage.send(bot)
    return sent
  }
}

/**
 * @type {Map<string, ArticleRateLimiter>}
 */
ArticleRateLimiter.limiters = new Map()

ArticleRateLimiter.sent = 0
ArticleRateLimiter.blocked = 0

if (process.env.NODE_ENV !== 'test') {
  ArticleRateLimiter.timer = setInterval(async () => {
    try {
      await ArticleRateLimiter.updateArticlesSent()
      await ArticleRateLimiter.updateArticlesBlocked()
    } catch (err) {
      const log = createLogger()
      log.error(err, 'Failed to update article stats')
    }
  }, 10000)
}

module.exports = ArticleRateLimiter
