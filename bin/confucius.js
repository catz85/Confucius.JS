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

const NotificationType = {
    INFO: 'information',
    WARNING: 'warning',
    ERROR: 'error',
    QUESTION: 'question'
};

const NotificationTitle = {
    INFO: '<b>Информация</b><br>',
    WARNING: '<b>Предупреждение</b><br>',
    ERROR: '<b>Ошибка</b><br>',
}

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

const DeclineReasonsDescriptions = ['У пользователя отсутствует трейд-ссылка', 'Попытка вывести предметы',
    'Профиль пользователя скрыт', 'Обмен содержит предметы из других игр', 'Предмета нет на торговой площадке',
    'Слишком мало лотов предмета на торговой площадке', 'Ставка меньше минимальной',
    'Обмен содержит слишком много предметов', 'Слишком много предметов в одной игре',
    'Слишком много предметов от одного пользователя', 'Предложение недействительно',
    'Слишком мало времени до конца игры'];

const UserStatus = {DEFAULT: 0, VIP: 1, PREMIUM: 2, ULTIMATE: 3};

function Confucius() {
    var self = this;
    this.logger = {
        info: function (msg) {
            console.log(msg);
        },
        error: function (msg) {
            console.log(msg);
        }
    };
    process.on('uncaughtException', function (err) {
        self.logger.error('Непредвиденная ошибка:');
        self.logger.error(err.stack || err);
        self.logger.error('Приложение будет закрыто');
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
    self.logger.info('********** Конфуций v2.31 **********');
    self.connectMongo(function (arg0) {
        self.db = arg0;
        self.initInfo(function () {
            self.socketHandler = new SocketHandler(self.info.port);
            self.socketHandler.setUpListeners();
            self.steamLogon(function () {
                self.loadCurrentGame(function () {
                    self.setUpSocketListeners();
                    self.socketHandler.sendToAdmins('gameLoaded');
                    self.setUpGameListeners(self.currentGame);
                    self.checkEatenItems(function () {
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
}

Confucius.prototype.setUpSocketListeners = function () {
    var self = this;

    self.socketHandler.addAdminEventListener('requestStatus', function (socket) {
        self.sendStatus(socket);
    });

    self.socketHandler.addAdminEventListener('requestDB', function(socket) {

    });

    self.socketHandler.addAdminEventListener('pause', function (socket) {
        self.currentGame.pause(function (err) {
            socket.emit('paused', err);
        });
    });

    self.socketHandler.addAdminEventListener('unpause', function (socket) {
        self.currentGame.unpause(function (err) {
            socket.emit('unpaused', self.currentGame.state, err);
        });
    });

}

Confucius.prototype.sendStatus = function (socket) {
    var self = this;
    self.currentGame.getAllItems(function (items) {
        self.currentGame.selectWinner(function (winner) {
            if (winner) {
                self.steamHelper.getSteamUser(winner, function (user) {
                    socket.emit('statusUpdated', self.currentGame.id, self.currentGame.state,
                        self.currentGame.currentBank, items.length, Object.keys(self.currentGame.betsByPlayer).length,
                        self.currentGame.gameTimer, user.name, self.currentGame.float, self.currentGame.hash);
                });
            } else {
                socket.emit('statusUpdated', self.currentGame.id, self.currentGame.state,
                    self.currentGame.currentBank, items.length, Object.keys(self.currentGame.betsByPlayer).length,
                    self.currentGame.gameTimer, 'Не определён', self.currentGame.float, self.currentGame.hash);
            }

        });
    });
}

Confucius.prototype.checkEatenItems = function (callback) {
    var self = this;
    var gameInfo = {
        gameDuration: self.info.gameDuration,
        spinDuration: self.info.spinDuration,
        appID: self.info.appID
    };
    var timeCutoff = null;
    if (self.currentGame.startTime >= 0) {
        timeCutoff = self.currentGame.startTime;
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
                infoOnly: true
            }, function (game) {
                if (game)
                    timeCutoff = game.finishTime;
            });
        }
        catch (err) {
            self.logger.error(err.stack || err);
        }
    }
    if (timeCutoff && timeCutoff > 0) {
        self.currentGame.getAllItems(function (gameItems) {
            var allItems = gameItems.reduce(function (result, item) {
                result[item.id] = item;
                return result;
            }, {});
            self.steamHelper.getLastReceivedItems(timeCutoff, function (offers, cost) {
                if (data.length > 0) {
                    async.forEachOfSeries(offers, function (data, index, cbf) {
                        if (!allItems[data.items[0].id]) {
                            self.currentGame.addBet(data.owner, data.items, data.cost, function () {
                                cbf();
                            });
                        } else {
                            cbf();
                        }
                    }, function () {
                        self.currentGame.update(callback);
                    });
                }
                else
                    callback();
            });
        });
    } else {
        callback();
    }
}

Confucius.prototype.loadCurrentGame = function (callback) {
    var self = this;
    var gameInfo = {
        gameDuration: self.info.gameDuration,
        spinDuration: self.info.spinDuration,
        appID: self.info.appID
    };
    Game.createFromDB({
        id: self.info.currentGame,
        db: self.db,
        marketHelper: self.marketHelper,
        steamHelper: self.steamHelper,
        logger: self.logger,
        pauseTimer: self.info.pauseTimer,
        info: gameInfo
    }, function (game) {
        self.currentGame = game;
        if (!self.currentGame) {
            self.currentGame = new Game(self.info.currentGame, self.db, self.marketHelper, self.steamHelper,
                gameInfo, self.logger);
            self.saveGameAsCurrent(self.currentGame, callback);
        } else {
            callback();
        }
    });

}

Confucius.prototype.setUpGameListeners = function (game) {
    var self = this;

    game.on('fatalError', function () {
        self.terminate();
    });

    game.on('notification', function (msg, type) {
        self.notifyAdmins(msg, type);
    });

    game.on('updated', function () {
        self.socketHandler.adminClients.forEach(function(socket) {
           self.sendStatus(socket);
        });
    });

    game.on('stateChanged', function() {
        self.socketHandler.adminClients.forEach(function(socket) {
            self.sendStatus(socket);
        });
    })

    game.on('newGame', function (newGame) {
        self.saveGameAsCurrent(newGame, function () {
            self.currentGame = newGame;
        })
    });

    game.on('rollFinished', function () {
        self.socketHandler.send('update', self.currentGame.betsByPlayer);
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
            callback(users[0].status);
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
                    finishTime: -1
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
            domain: 'dota2bets.ru'
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
            self.notifyAdmins(NotificationTitle.INFO + 'Авторизация прошла успешно', NotificationType.INFO);
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
                                self.notifyAdmins('Получено предложение об обмене #' + offer.id + ' от <font color=orange>'
                                    + user.name + '</font>', NotificationType.INFO);
                                self.logger.info('Получено предложение об обмене #' + offer.id + ' от ' + user.name);
                                if (offer.itemsToGive.length <= 0) {
                                    if (user.privacyState === "public") {
                                        self.processItems(offer, function (items, totalCost, errorCode) {
                                            if (errorCode < 0) {
                                                if (totalCost >= self.info.minBet * 100) {
                                                    if (items.length <= self.info.maxItemsPerTrade) {
                                                        self.currentGame.getAllItems(function (allItems) {
                                                            if (items.length +
                                                                allItems.length <= self.info.maxItems) {
                                                                if (!self.currentGame.betsByPlayer
                                                                    || !self.currentGame.betsByPlayer[user.steamID.getSteamID64()]
                                                                    || self.currentGame.betsByPlayer[user.steamID.getSteamID64()].count
                                                                    + items.length <= self.info.maxItemsPerUser) {
                                                                    self.steamHelper.acceptTradeOffer(offer, function (newItems) {
                                                                        self.processedOffers.splice(self.processedOffers.indexOf(offer.id), 1);
                                                                        self.notifyAdmins(NotificationTitle.INFO + 'Предложение #'
                                                                            + offer.id + ' принято', NotificationType.INFO);
                                                                        self.logger.info('Предложение #' + offer.id + ' принято');
                                                                        self.currentGame.addBet(user, newItems, totalCost, function () {
                                                                            self.currentGame.update();
                                                                        });
                                                                    });
                                                                } else {
                                                                    self.declineBet(offer, DeclineReasons.TOO_MANY_ITEMS_FROM_USER);
                                                                }
                                                            } else {
                                                                self.declineBet(offer, DeclineReasons.TOO_MANY_ITEMS);
                                                            }
                                                        });
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
        self.notifyAdmins('<b>Обмен отклонен</b><br>' + DeclineReasonsDescriptions[reason], NotificationType.WARNING);
        self.logger.info('Обмен № ' + offer.id + ' отклонен: ' + DeclineReasonsDescriptions[reason]);
        self.socketHandler.sendToUser(offer.partner.getSteamID64(), 'offerDeclined',
            reason);
    });
}

Confucius.prototype.notifyAdmins = function (msg, type) {
    var self = this;
    self.socketHandler.sendToAdmins('notification', msg, type);
}

Confucius.prototype.terminate = function () {
    var self = this;
    self.logger.info('Закрытие соединения и завершение работы');
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
        if (self.socketHandler)
            self.socketHandler.sendToAdmins('logMsg', args.message, args.level);
        return logMessage;
    }

    function formatterFile(args) {
        var date = moment().format('HH:mm:ss');
        var logMessage = '[' + date + ' ' + args.level.toUpperCase() + ']: ' + args.message;
        return logMessage;
    }

    var logDataFile = self.config['logDirectory'] + '/logdata.json';
    var dateString = moment().format('YYYY-MM-DD HH-mm-ss');
    if (fs.existsSync(logDataFile)) {
        var logData = JSON.parse(fs.readFileSync(logDataFile, 'utf-8'));
        if (fs.existsSync(self.config['logDirectory'] + '/latest.log')) {
            fs.rename(self.config['logDirectory'] + '/latest.log', self.config['logDirectory'] + '/' + logData['lastDate'] + '.log');
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
                formatter: formatterFile
            })
        ]
    });
    return logger;
}

Confucius.prototype.connectMongo = function (callback) {
    var self = this;
    self.logger.info('Установка соединения с базой данных');
    MongoClient.connect(self.config['mongodb'], function (err, db) {
        if (err) {
            self.logger.error('Не удалось соединиться с базой данных:');
            self.logger.error(err.stack || err);
            self.terminate();
        } else {
            self.logger.info('Соединение с базой данных установлено');
            if (callback)
                callback(db);
        }
    });
}

const INSTANCE = new Confucius();
INSTANCE.start();
