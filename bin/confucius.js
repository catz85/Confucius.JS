/**
 * Created by BronzeBee on 12.05.2016.
 */

var fs = require('fs');
var winston = require('winston');
var moment = require('moment');
var mongodb = require('mongodb');
var MongoClient = mongodb.MongoClient;
var async = require('async');

var MarketHelper = require('./steamMarketHelper.js');
var SteamHelper = require('./steamHelper.js');
var Game = require('./game.js');
var SocketHandler = require('./socketHandler.js');

const CONFIG_FILE = './config.json';

const TRADE_OFFER_ACCEPT_TIME = 0;
const ITEM_HANDLING_TIME = 0;

const RETRY_INTERVAL = 3000;
const MAX_RETRIES = 5;

const VERSION = '2.39';

const NotificationType = {
    INFO: 'information',
    WARNING: 'warning',
    ERROR: 'error',
    QUESTION: 'question'
};

const DeclineReasons = {
    NO_TRADE_LINK: 0,
    ITEMS_TO_GIVE: 1,
    PRIVATE_PROFILE: 2,
    WRONG_ITEMS: 3,
    NO_MARKET_LOTS: 4,
    TOO_FEW_MARKET_LOTS: 5,
    LOW_BET: 6,
    TOO_MANY_ITEMS_IN_TRADE: 7,
    TOO_MANY_ITEMS: 8,
    TOO_MANY_ITEMS_FROM_USER: 9,
    INVALID_OFFER: 10,
    TOO_LITTLE_TIME: 11
};

const UserStatus = {
    DEFAULT: 0,
    VIP: 1,
    PREMIUM: 2,
    ULTIMATE: 3,
    MODERATOR: 4,
    ADMIN: 5
};

function Confucius() {
    var self = this;
    this.logger = {
        info: function (msg) {
            console.log(msg);
        },
        error: function (msg) {
            console.log(msg);
        },
        warning: function (msg) {
            console.log(msg);
        },
        toLocal: function (msg) {
            return msg;
        }
    };
    process.on('uncaughtException', function (err) {
        self.logger.error('error.unhandled');
        self.logger.error(err.stack || err);
        self.logger.error('error.exit');
        self.terminate();
    });
    this.config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    this.logger = this.createLogger();
    this.info = {};
    this.socketHandler = null;
    this.steamHelper = null;
    this.marketHelper = null;
    this.currentGame = null;
    this.processedOffers = [];
    this.localeData = JSON.parse(fs.readFileSync('./lang/' + this.config.language + '.json', 'utf-8'));
}

Confucius.prototype.localize = function (str, dictionary) {
    var self = this;
    var text = self.localeData[str] ? self.localeData[str] : str;
    if (dictionary) {
        for (var key in dictionary) {
            text = text.replace(new RegExp(key, 'g'), dictionary[key].toString());
        }
    }
    return text;
}

Confucius.prototype.initInfo = function (callback) {
    var self = this;
    var infoData = self.db.collection('info').find();
    infoData.toArray(function (err, items) {
        if (err) {
            self.logger.error(err.stack || err);
            self.terminate();
        } else {
            async.forEachOfSeries(items, function (data, index, cb) {
                self.info[data.name] = data.value;
                cb();
            }, function () {
                if (callback)
                    callback();
            });
        }
    });
}

Confucius.prototype.calcTradeOfferProcessingTime = function (numItems) {
    return TRADE_OFFER_ACCEPT_TIME + numItems * ITEM_HANDLING_TIME;
}

Confucius.prototype.start = function () {
    var self = this;
    self.logger.info('startup', {"%s%": VERSION});
    self.connectMongo(function (arg0) {
        self.db = arg0;
        self.initInfo(function () {
            self.socketHandler = new SocketHandler(self.info.port);
            self.socketHandler.addEventListener('connection', function (socket) {
                if (self.currentGame)
                    socket.emit('updateInfo', {
                        playersData: self.currentGame.betsByPlayer,
                        bank: self.currentGame.currentBank,
                        itemsCount: self.currentGame.numItems
                    });
            });
            self.socketHandler.setUpListeners();
            self.steamLogon(function () {
                Game.setOldGameListener(function (game) {
                    self.setUpGameListeners(game);
                });
                self.loadCurrentGame(function (resumeCallback) {
                    Game.fixGameErrors(self.db, self.marketHelper, self.steamHelper, {
                        gameDuration: self.info.gameDuration,
                        spinDuration: self.info.spinDuration,
                        appID: self.info.appID,
                        domain: self.info.domain,
                        jackpot: self.info.jackpot
                    }, self.logger, function () {
                        self.setUpSocketListeners();
                        self.setUpGameListeners(self.currentGame);
                        self.checkEatenItems(function () {
                            if (resumeCallback)
                                resumeCallback();
                            self.socketHandler.sendToAdmins('gameLoaded');
                            self.steamHelper.forceCheckTradeOffers(function () {
                                self.steamHelper.on('autoOffer', function (offer) {
                                    self.handleTradeOffer(offer);
                                });
                            })
                        });
                    });
                });
            });
        });
    });
}

Confucius.prototype.setUpSocketListeners = function () {
    var self = this;

    self.socketHandler.addAdminEventListener('requestStatus', function (socket) {
        self.sendStatus(socket);
    });

    self.socketHandler.addAdminEventListener('requestDB', function (socket) {

    });

    self.socketHandler.addAdminEventListener('pause', function (socket) {
        self.currentGame.pause(function (errText) {
            if (errText)
                self.logger.warning(errText);
            socket.emit('paused', errText);
        });
    });

    self.socketHandler.addAdminEventListener('unpause', function (socket) {
        self.currentGame.unpause(function (errText) {
            if (errText)
                self.logger.warning(errText);
            socket.emit('unpaused', self.currentGame.state, errText);
        });
    });

}

Confucius.prototype.sendStatus = function (socket) {
    var self = this;
    self.currentGame.selectWinner(function (winner) {
        if (winner) {
            self.steamHelper.getSteamUser(winner, function (user) {
                socket.emit('statusUpdated', self.currentGame.id, self.currentGame.state,
                    self.currentGame.currentBank, self.currentGame.numItems, Object.keys(self.currentGame.betsByPlayer).length,
                    self.currentGame.state === Game.State.PAUSED ? self.currentGame.pauseTimer
                        : self.currentGame.gameTimer, user.name, self.currentGame.float, self.currentGame.hash);
            });
        } else {
            socket.emit('statusUpdated', self.currentGame.id, self.currentGame.state,
                self.currentGame.currentBank, self.currentGame.numItems, Object.keys(self.currentGame.betsByPlayer).length,
                self.currentGame.state === Game.State.PAUSED ? self.currentGame.pauseTimer
                    : self.currentGame.gameTimer, 'Не определён', self.currentGame.float, self.currentGame.hash);
        }

    });
}

Confucius.prototype.checkEatenItems = function (callback) {
    var self = this;
    if (self.currentGame.id === 1)
        callback();
    else {
        var gameInfo = {
            gameDuration: self.info.gameDuration,
            spinDuration: self.info.spinDuration,
            appID: self.info.appID,
            domain: self.info.domain,
            jackpot: self.info.jackpot
        };
        var timeCutoff = null;
        var checkMissingBets = function () {
            if (timeCutoff && timeCutoff > 0) {
                self.currentGame.getAllItems(function (gameItems) {
                    var allItems = gameItems.reduce(function (result, item) {
                        result[item.id] = item;
                        return result;
                    }, {});
                    self.steamHelper.getLastReceivedItems(timeCutoff, function (items, cost) {
                        if (items.length > 0) {
                            async.forEachOfSeries(items, function (data, index, cbf) {
                                if (!allItems[data.items[0].id]) {
                                    self.steamHelper.getSteamUser(data.owner, function (user) {
                                        self.currentGame.addBet(user, data.items, data.totalCost, function () {
                                            cbf();
                                        });
                                    });
                                } else {
                                    cbf();
                                }
                            }, function () {
                                callback();
                            });
                        }
                        else
                            callback();
                    });
                });
            } else {
                callback();
            }
        };
        if (self.currentGame.startTime >= 0) {
            timeCutoff = self.currentGame.startTime;
            checkMissingBets();
        } else {
            try {
                Game.createFromDB({
                    id: self.info.currentGame - 1,
                    db: self.db,
                    marketHelper: self.marketHelper,
                    steamHelper: self.steamHelper,
                    logger: self.logger,
                    pauseTimer: -1,
                    info: gameInfo,
                }, function (game) {
                    if (game)
                        timeCutoff = game.finishTime;
                    checkMissingBets();
                });
            }
            catch (err) {
                self.logger.error(err.stack || err);
                callback();
            }
        }
    }

}

Confucius.prototype.loadCurrentGame = function (callback) {
    var self = this;
    var gameInfo = {
        gameDuration: self.info.gameDuration,
        spinDuration: self.info.spinDuration,
        appID: self.info.appID,
        domain: self.info.domain,
        jackpot: self.info.jackpot
    };
    Game.createFromDB({
        id: self.info.currentGame,
        db: self.db,
        marketHelper: self.marketHelper,
        steamHelper: self.steamHelper,
        logger: self.logger,
        pauseTimer: self.info.pauseTimer,
        info: gameInfo
    }, function (game, resumeCallback) {
        self.currentGame = game;
        if (!self.currentGame) {
            self.currentGame = new Game(self.info.currentGame, self.db, self.marketHelper, self.steamHelper,
                gameInfo, self.logger);
            self.saveGameAsCurrent(self.currentGame, function () {
                callback(resumeCallback);
            });
        } else {
            callback(resumeCallback);
        }
    });

}

Confucius.prototype.setUpGameListeners = function (game) {
    var self = this;

    game.on('fatalError', function () {
        self.terminate();
    });

    game.on('notification', function (msg, type, dictionary) {
        self.notifyAdmins(msg, type, dictionary);
    });

    game.on('updateStats', function (stats) {
        self.socketHandler.send('updateStats', stats);
    });

    game.on('updated', function () {
        self.socketHandler.adminClients.forEach(function (socket) {
            self.sendStatus(socket);
        });
    });

    game.on('newBet', function (bet) {
        self.socketHandler.send('newBet', bet);
        self.socketHandler.send('updateInfo', {
            playersData: self.currentGame.betsByPlayer,
            bank: self.currentGame.currentBank,
            itemsCount: self.currentGame.numItems
        });
    });

    game.on('stateChanged', function () {
        self.socketHandler.adminClients.forEach(function (socket) {
            self.sendStatus(socket);
        });
    })

    game.on('newGame', function (newGame, noRewrite) {
        if (noRewrite) {
            self.currentGame = newGame;
        } else {
            self.saveGameAsCurrent(newGame, function () {
                self.currentGame = newGame;
            });
        }

    });

    game.on('saveGame', function (newGame) {
        self.saveGameAsCurrent(newGame, function () {
        })
    });

    game.on('rollFinished', function (data) {
        self.socketHandler.send('clear', data);
    });

    game.on('timerChanged', function (time) {
        self.socketHandler.send('timerChanged', time);
    });

    game.on('calcFee', function (user, callback) {
        self.getUserStatus(user.steamID.getSteamID64(), function (status) {
            callback(self.info.fee[status]);
        });
    });

}

Confucius.prototype.getUserStatus = function (steamID, callback) {
    var self = this;
    self.db.collection('users').find({steamID: steamID}).toArray(function (err, users) {
        if (err) {
            self.logger.error(err.stack || err);
            setTimeout(function () {
                self.getUserStatus(steamID, callback);
            }, RETRY_INTERVAL / 2);
        } else {
            callback(users[0].status ? users[0].status : UserStatus.DEFAULT);
        }
    });
}

Confucius.prototype.saveGameAsCurrent = function (game, callback, numRetries) {
    var self = this;
    self.db.collection('info').updateOne({name: 'currentGame'}, {$set: {value: game.id}}, {w: 1},
        function (error, result) {
            if (error) {
                self.logger.error(error.stack || error);
                if (numRetries)
                    numRetries = 1;
                else numRetries++;
                if (numRetries < MAX_RETRIES)
                    setTimeout(function () {
                        self.saveGameAsCurrent(game, callback, numRetries);
                    }, RETRY_INTERVAL / 2);
                else
                    self.terminate();
            } else {
                self.db.collection('games').insertOne({
                    id: game.id,
                    startTime: -1,
                    bank: game.currentBank,
                    bets: game.bets,
                    float: game.float,
                    hash: game.hash,
                    state: game.state,
                    finishTime: -1,
                    numItems: game.numItems
                }, {w: 1}, function (err, result) {
                    if (err) {
                        if (numRetries)
                            numRetries = 1;
                        else numRetries++;
                        if (numRetries < MAX_RETRIES)
                            setTimeout(function () {
                                self.saveGameAsCurrent(game, callback, numRetries);
                            }, RETRY_INTERVAL / 2);
                        else
                            self.terminate();
                    } else {
                        if (callback)
                            callback();
                    }
                });
            }
        });

}

Confucius.prototype.steamLogon = function (callback) {
    var self = this;
    self.marketHelper = new MarketHelper(self.info.backpackAPIKey, self.info.appID, self.info.priceUpdateInterval,
        self.logger);
    self.marketHelper.start(function () {
        var logOnDetails = {
            accountName: self.config.accountName,
            password: self.config.password,
            sentry: self.config.sentryFile,
            sharedSecret: self.config.sharedSecret,
            identitySecret: self.config.identitySecret,
            domain: self.info.domain
        };
        self.steamHelper = new SteamHelper(logOnDetails, self.marketHelper, self.logger);

        self.steamHelper.on('loggedIn', function () {
            self.socketHandler.sendToAdmins('logMsg', 'Авторизован', 'info');
        });

        self.steamHelper.on('terminate', function () {
            self.terminate();
        });

        self.steamHelper.on('forceOffer', function (offer) {
            self.handleTradeOffer(offer);
        });

        self.steamHelper.login(function () {
            self.notifyAdmins(self.localize('steam.loggedIn'), NotificationType.INFO);
            callback();
        });
    });
}

Confucius.prototype.handleTradeOffer = function (offer) {
    var self = this;
    if (self.processedOffers.indexOf(offer.id) < 0) {
        self.processedOffers.push(offer.id);
        if (self.info.trading && self.currentGame.state !== Game.State.PAUSED) {
            if (self.calcTradeOfferProcessingTime(offer.itemsToReceive.length) < self.currentGame.gameTimer * 1000) {
                self.currentGame.getUserToken(offer.partner.getSteamID64(), function (token) {
                    if (token) {
                        if (offer.state === 2 && !offer._isGlitched()) {
                            self.steamHelper.getSteamUser(offer.partner.getSteamID64(), function (user) {
                                self.logger.info('trade.received', {
                                        "%id%": offer.id,
                                        "%user%": user.name
                                    },
                                    NotificationType.INFO);
                                if (offer.itemsToGive.length <= 0) {
                                    if (user.privacyState === 'public') {
                                        self.processItems(offer, function (items, totalCost, errorCode) {
                                            if (errorCode < 0) {
                                                if (totalCost >= self.info.minBet * 100) {
                                                    if (items.length <= self.info.maxItemsPerTrade) {
                                                        if (self.currentGame.numItems +
                                                            items.length <= self.info.maxItems) {
                                                            if (!self.currentGame.betsByPlayer
                                                                || !self.currentGame.betsByPlayer[user.steamID.getSteamID64()]
                                                                || self.currentGame.betsByPlayer[user.steamID.getSteamID64()].count
                                                                + items.length <= self.info.maxItemsPerUser) {
                                                                self.steamHelper.acceptTradeOffer(offer, function (newItems) {
                                                                    self.processedOffers.splice(self.processedOffers.indexOf(offer.id), 1);
                                                                    self.logger.info('trade.accepted',
                                                                        {"%id%": offer.id},
                                                                        NotificationType.INFO);
                                                                    self.currentGame.addBet(user, newItems, totalCost, function () {

                                                                    });
                                                                });
                                                            } else {
                                                                self.declineBet(offer, DeclineReasons.TOO_MANY_ITEMS_FROM_USER);
                                                            }
                                                        } else {
                                                            self.declineBet(offer, DeclineReasons.TOO_MANY_ITEMS);
                                                        }
                                                    } else {
                                                        self.declineBet(offer, DeclineReasons.TOO_MANY_ITEMS_IN_TRADE);
                                                    }
                                                } else {
                                                    self.declineBet(offer, DeclineReasons.LOW_BET);
                                                }
                                            } else {
                                                self.declineBet(offer, errorCode);
                                            }
                                        });
                                    } else {
                                        self.declineBet(offer, DeclineReasons.PRIVATE_PROFILE);
                                    }
                                } else {
                                    self.declineBet(offer, DeclineReasons.ITEMS_TO_GIVE);
                                }
                            });
                        } else {
                            self.declineBet(offer, DeclineReasons.INVALID_OFFER);
                        }
                    } else {
                        self.declineBet(offer, DeclineReasons.NO_TRADE_LINK);
                    }
                });
            } else {
                self.declineBet(offer, DeclineReasons.TOO_LITTLE_TIME);
            }
        }
    }
}

Confucius.prototype.processItems = function (offer, callback) {
    var self = this;
    var totalCost = 0;
    var items = offer.itemsToReceive;
    async.forEachOfSeries(items, function (item, key, cb) {
        if (item.appid !== self.info.appID) {
            callback(null, 0, DeclineReasons.WRONG_ITEMS);
        } else {
            var marketInfo = self.marketHelper.getItemData(item.market_hash_name);
            if (!marketInfo) {
                callback(null, 0, DeclineReasons.NO_MARKET_LOTS);
            } else if (Number(marketInfo.quantity) < self.info.minMarketLots) {
                callback(null, 0, DeclineReasons.TOO_FEW_MARKET_LOTS);
            } else {
                totalCost += Number(marketInfo.value);
                item.owner = offer.partner.getSteamID64();
                item.cost = marketInfo.value;
                cb();
            }
        }
    }, function () {
        callback(items, totalCost, -1);
    });
}

Confucius.prototype.declineBet = function (offer, reason) {
    var self = this;
    self.steamHelper.declineTradeOffer(offer, function () {
        self.processedOffers.splice(self.processedOffers.indexOf(offer.id), 1);
        self.logger.info('trade.declined.' + reason, {"%id%": offer.id}, NotificationType.WARNING);
        self.socketHandler.sendToUser(offer.partner.getSteamID64(), 'offerDeclined',
            reason);
    });
}

Confucius.prototype.notifyAdmins = function (msg, type, dictionary) {
    var self = this;
    self.socketHandler.sendToAdmins('notification', msg, type, dictionary);
}

Confucius.prototype.terminate = function () {
    var self = this;
    self.logger.info('stopping');
    if (self.db)
        self.db.close();
    if (self.marketHelper)
        clearTimeout(self.marketHelper.taskID);
    try {
        self.steamHelper.steamCommunity.chatLogoff()
        self.steamHelper.steamUser.logOff();
    } catch (err) {

    } finally {
        setTimeout(function () {
            process.exit(0);
        }, 2000);
    }
}

Confucius.prototype.createLogger = function () {
    var self = this;

    function formatter(args) {
        var date = moment().format('HH:mm:ss');
        var logMessage = '[' + date + ' ' + args.level.toUpperCase() + ']: ' + args.message;
        return logMessage;
    }

    var logDataFile = self.config['logDirectory'] + '/logdata.json';
    var dateString = moment().format('YYYY-MM-DD HH-mm-ss');
    if (fs.existsSync(logDataFile)) {
        var logData = JSON.parse(fs.readFileSync(logDataFile, 'utf-8'));
        if (fs.existsSync(self.config['logDirectory'] + '/latest.log')) {
            fs.rename(self.config['logDirectory'] + '/latest.log', self.config['logDirectory']
                + '/' + logData['lastDate'] + '.log');
        }
        logData['lastDate'] = dateString;
        fs.writeFileSync(logDataFile, JSON.stringify(logData), 'utf-8');
    } else {
        var logData = {lastDate: dateString};
        fs.writeFileSync(logDataFile, JSON.stringify(logData), 'utf-8');
    }
    var logger = new winston.Logger({
        json: false,
        transports: [
            new (winston.transports.Console)({
                handleExceptions: true,
                json: false,
                formatter: formatter
            }),
            new (winston.transports.File)({
                filename: self.config['logDirectory'] + '/latest.log',
                handleExceptions: true,
                json: false,
                formatter: formatter
            })
        ]
    });

    var localLogFunc = function (print, msg, dictionary, notify) {
        if (self.socketHandler) {
            self.socketHandler.sendToAdmins('logMsg', print.name, msg, dictionary);
            if (notify) {
                self.notifyAdmins(msg, notify, dictionary);
            }
        }
        var localMsg = self.localize(msg, dictionary);
        print(localMsg);
    };

    var localLogger = {

        info: function (msg, dictionary, notify) {
            localLogFunc(logger.info, msg, dictionary, notify);
        },

        error: function (msg, dictionary, notify) {
            localLogFunc(logger.error, msg, dictionary, notify);
        },

        warning: function (msg, dictionary, notify) {
            localLogFunc(logger.warning, msg, dictionary, notify);
        },

        toLocal: function (msg, dictionary) {
            return self.localize(msg, dictionary);
        }

    }
    return localLogger;
}

Confucius.prototype.connectMongo = function (callback) {
    var self = this;
    self.logger.info('connectingDB');
    MongoClient.connect(self.config['mongodb'], function (err, db) {
        if (err) {
            self.logger.error('error.connectDB');
            self.logger.error(err.stack || err);
            self.terminate();
        } else {
            self.logger.info('connectedDB');
            if (callback)
                callback(db);
        }
    });
}

const INSTANCE = new Confucius();
INSTANCE.start();
