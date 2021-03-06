/**
 * Created by BronzeBee on 20.05.2016.
 */

var async = require('async');
var crypto = require('crypto');
var events = require('events');
var util = require('util');

util.inherits(Game, events.EventEmitter);

const State = {
    WAITING: 0,
    ACTIVE: 1,
    ROLLING: 2,
    SENDING: 3,
    SENT: 4,
    ERROR: 5,
    PAUSED: 6
};

const NotificationType = {
    INFO: 'information',
    WARNING: 'warning',
    ERROR: 'error',
    QUESTION: 'question'
};

const RETRY_INTERVAL = 3000;
const MAX_RETRIES = 5;

function Game(id, db, marketHelper, steamHelper, info, logger) {
    this.id = id;
    this.info = info;
    this.db = db;
    this.marketHelper = marketHelper;
    this.steamHelper = steamHelper;
    this.gameTimer = info.gameDuration;
    this.currentBank = 0;
    this.bets = [];
    this.numItems = 0;
    this.float = Math.random();
    this.hash = crypto.createHash('md5').update(this.float + '').digest('hex');
    this.timerID = -1;
    this.state = State.WAITING;
    this.betsByPlayer = {};
    this.winner = null;
    this.pauseTimer = -1;
    this.betsQueue = [];
    this.logger = logger ? logger : {
        error: function (msg) {
            console.log(msg);
        }, info: function (msg) {
            console.log(msg);
        },
        warning: function (msg) {
            console.log(msg);
        },
        toLocal: function (msg) {
            return msg;
        }
    }
}

Game.State = State;

Game.setOldGameListener = function (listener) {
    Game.oldGameListener = listener;
};

Game.createFromDB = function (data, callback, numRetries) {
    data.db.collection('games').find({id: data.id}).toArray(function (err, items) {
        if (err) {
            if (!numRetries)
                numRetries = 1;
            else
                numRetries++;
            if (numRetries < MAX_RETRIES)
                Game.createFromDB(data, callback, numRetries);
            else {
                callback(null, null, new Error('game.error.db'));
            }
        } else {
            if (items.length > 0) {
                var gameData = items[0];
                var game = new Game(data.id, data.db, data.marketHelper, data.steamHelper, data.info, data.logger);
                var resumeCallback = function (callback) {
                    game.resume({
                        startTime: gameData.startTime,
                        finishTime: gameData.finishTime,
                        bank: gameData.bank,
                        bets: gameData.bets,
                        winner: gameData.winner,
                        float: gameData.float,
                        hash: gameData.hash,
                        state: gameData.state,
                        pauseTimer: data.pauseTimer
                    }, callback);
                };
                game.winner = gameData.winner;
                game.currentBank = gameData.bank;
                game.bets = gameData.bets;
                game.float = gameData.float;
                game.hash = gameData.hash;
                game.startTime = gameData.startTime;
                game.state = gameData.state;
                game.finishTime = gameData.finishTime;
                game.numItems = gameData.numItems;
                callback(game, resumeCallback);
            } else {
                callback(null);
            }
        }
    });
};

Game.fixGameErrors = function (db, marketHelper, steamHelper, info, logger, callback) {
    db.collection('games').find({state: State.ERROR}).toArray(function (err, games) {
        if (!err) {
            async.forEachOfSeries(games, function (gameData, index, cb) {
                Game.createFromDB({
                    id: gameData.id,
                    db: db,
                    marketHelper: marketHelper,
                    steamHelper: steamHelper,
                    info: info,
                    logger: logger,
                    pauseTimer: -1
                }, function (game) {
                    Game.oldGameListener(game);
                    game.setState(State.SENDING, function () {
                        steamHelper.getSteamUser(gameData.winner, function (user) {
                            game.sortWonItems(user, function (items) {
                                game.sendWonItems(items, user, null, function (offer, err) {
                                    if (err) {
                                        game.setState(State.ERROR, cb);
                                    } else {
                                        game.setState(State.SENT, cb);
                                    }
                                });
                            });
                        });

                    });
                });
            }, function () {
                if (callback)
                    callback();
            });
        } else {
            logger.error('game.error.list');
            logger.error(err.stack || err);
            if (callback)
                callback();
        }
    });
};

Game.prototype.addBet = function (better, items, totalCost, isQueued, callback, numRetries) {
    var self = this;
    var itemsArray = [];
    var costFrom = self.currentBank + 1;
    var costTo = self.currentBank + totalCost;
    async.forEachOfSeries(items, function (item, key, cb) {
        var newItem = {
            id: item.id,
            name: item.name,
            market_hash_name: item.market_hash_name,
            cost: item.cost,
            image: item.getImageURL('full')
        };
        itemsArray.push(newItem);
        cb();
    }, function () {

        var bet = {
            steamID: better.steamID.getSteamID64(),
            nickname: better.name,
            deposit: totalCost,
            avatar: better.getAvatarURL('full'),
            items: itemsArray,
            costFrom: costFrom,
            costTo: costTo
        };
        self.db.collection('games').updateOne({id: self.id}, {
                $push: {bets: bet},
                $set: {numItems: self.numItems + itemsArray.length}
            },
            {w: 1}, function (err) {
                if (err) {
                    self.logger.error('game.error.bet');
                    self.logger.error(err.stack || err);
                    if (numRetries)
                        numRetries = 1;
                    else
                        numRetries++;
                    if (numRetries < MAX_RETRIES)
                        setTimeout(function () {
                            self.addBet(better, items, totalCost, callback, numRetries);
                        }, RETRY_INTERVAL / 3);
                    else
                        self.emit('fatalError');
                } else {
                    self.currentBank += totalCost;
                    self.numItems += itemsArray.length;
                    self.bets.push(bet);
                    if (isQueued) {
                        self.betsQueue.push(bet);
                    } else {
                        self.update(function () {
                            self.emit('newBet', bet);
                            callback();
                        });
                    }

                }
            });
    });
};

Game.prototype.sortBetsByPlayer = function (callback) {
    var self = this;
    var sortedItems = {};
    self.getAllItems(function (gameItems, numBetsByPlayer) {
        async.forEachOfSeries(gameItems, function (item, index, cb) {
            var data = null;
            if (sortedItems[item.owner]) {
                data = self.marketHelper.getItemData(item.market_hash_name);
                sortedItems[item.owner].totalCost += data.value;
                sortedItems[item.owner].count++;
            } else {
                sortedItems[item.owner] = {totalCost: 0, count: 0, chance: 0};
                data = self.marketHelper.getItemData(item.market_hash_name);
                sortedItems[item.owner].totalCost += data.value;
                sortedItems[item.owner].count++;
                sortedItems[item.owner].numBets = numBetsByPlayer[item.owner];
            }
            cb();
        }, function () {
            self.betsByPlayer = sortedItems;
            self.recalculateChance(function () {
                if (callback)
                    callback();
            });
        });
    });
};

Game.prototype.recalculateChance = function (callback) {
    var self = this;
    async.forEachOfSeries(self.betsByPlayer, function (data, key, cb) {
        self.betsByPlayer[key].chance = Number((Number(data.totalCost) * 100.0 / self.currentBank).toFixed(2));
        cb();
    }, function () {
        if (callback)
            callback();
    });
};

Game.prototype.setState = function (newState, callback, numRetries) {
    var self = this;
    if (self.state !== newState) {
        self.db.collection('games').updateOne({id: self.id}, {$set: {state: newState}}, {w: 1}, function (err) {
            if (err) {
                if (!numRetries)
                    numRetries = 1;
                else
                    numRetries++;
                self.logger.error('game.error.state', {"%id%": self.id});
                self.logger.error(err.stack || err);
                if (numRetries < MAX_RETRIES) {
                    self.logger.error('error.retrying');
                    setTimeout(function () {
                        self.setState(newState, callback, numRetries);
                    }, RETRY_INTERVAL / 2);
                } else {
                    self.emit('fatalError');
                }
            } else {
                self.logger.info('game.stateChanged', {
                    "%id%": self.id,
                    "%state1%": Object.keys(State)[self.state],
                    "%state2%": Object.keys(State)[newState]
                }, NotificationType.INFO);
                self.state = newState;
                self.emit('stateChanged', newState);
                if (callback)
                    callback();
            }
        });
    } else {
        if (callback)
            callback();
    }
};

Game.prototype.selectWinner = function (callback) {
    var self = this;
    if (self.winner) {
        callback(self.winner);
    } else {
        var winnerNumber = Math.max((self.currentBank * self.float).toFixed(0) * 1, 1);
        async.forEachOfSeries(self.bets, function (bet, key, cb) {
            if (winnerNumber >= Number(bet.costFrom) && winnerNumber <= Number(bet.costTo)) {
                callback(bet.steamID);
            } else {
                cb();
            }
        }, function () {
            callback(null);
        });
    }
};


Game.prototype.pause = function (callback) {
    var self = this;
    if (!callback)
        callback = function () {

        };
    if (self.state === State.ACTIVE || self.state === State.WAITING) {
        var time = self.gameTimer;
        clearInterval(self.timerID);
        self.db.collection('info').updateOne({name: 'pauseTimer'}, {$set: {value: time}}, {w: 1}, function (err) {
            if (err) {
                self.logger.error(err.stack || err);
                self.startTimer();
            } else {
                self.pauseTimer = time;
                self.setState(State.PAUSED, function () {
                    callback(null);
                });
            }
        });
    } else {
        callback('game.error.pause');
    }
};

Game.prototype.unpause = function (callback) {
    if (!callback)
        callback = function () {

        };
    var self = this;
    if (self.state === State.PAUSED) {
        self.db.collection('info').updateOne({name: 'pauseTimer'}, {$set: {value: -1}}, {w: 1}, function (err) {
            if (err) {
                self.logger.error(err.stack || err);
                callback(err);
            } else {
                var timer = self.pauseTimer;
                self.pauseTimer = -1;
                self.gameTimer = timer;
                self.update(function () {
                    callback(null);
                });
            }
        });
    } else {
        callback('game.error.unpause');
    }
};

Game.prototype.saveFinishTime = function (time, callback, numRetries) {
    var self = this;
    var id = self.id;
    self.db.collection('games').updateOne({id: id}, {$set: {finishTime: time}}, {w: 1}, function (error) {
        if (error) {
            if (!numRetries)
                numRetries = 1;
            else
                numRetries++;
            self.logger.error(error.stack || error);
            if (numRetries < MAX_RETRIES) {
                setTimeout(function () {
                    self.saveFinishTime(time, id, callback, numRetries);
                }, RETRY_INTERVAL / 2);
            }
        } else {
            callback();
        }
    });
};

Game.prototype.roll = function (callback) {
    var self = this;
    self.setState(State.ROLLING, function () {
        self.selectWinner(function (winnerID) {
            self.winner = winnerID;
            var newGame = new Game(self.id + 1, self.db, self.marketHelper, self.steamHelper, self.info,
                self.logger);
            self.emit('newGame', newGame, true);
            self.steamHelper.getSteamUser(winnerID, function (winner) {
                self.logger.info('game.finished', {
                        "%id%": self.id,
                        "%winner%": winner.name
                    },
                    NotificationType.INFO);

                self.emit('rollStarted', {
                    winnerName: winner.name,
                    winnerChance: self.betsByPlayer[winnerID].chance,
                    winnerBank: self.currentBank,
                    winnerTicket: Number((self.currentBank * self.float).toFixed(0)),
                    winnerNumber: self.float,
                    winnerAvatar: winner.getAvatarURL('medium')
                }, self);
                var rollTime = Date.now();
                self.finishTime = Date.now();
                self.saveFinishTime(self.finishTime, function () {
                    self.sortWonItems(winner, function (wonItems) {
                        self.getUserToken(winnerID, function (token) {
                            var timeout = self.info.spinDuration * 1000 - (Date.now() - rollTime);
                            setTimeout(function () {
                                self.emit('rollFinished', {
                                    id: newGame.id,
                                    hash: newGame.hash,
                                    winnerName: winner.name,
                                    winnerAvatar: winner.getAvatarURL('full'),
                                    bank: self.currentBank,
                                    chance: Number(self.betsByPlayer[winnerID].chance)
                                });
                                self.submit(winner, Number(self.betsByPlayer[winnerID].chance), function () {
                                    self.emit('history', self.id, wonItems);
                                    self.setState(State.SENDING, function () {
                                        self.sendWonItems(wonItems, winner, token, function (offer, err) {
                                            self.setState(err ? State.ERROR : State.SENT, function () {
                                                self.emit('saveGame', newGame);
                                                newGame.processQueuedBets();
                                                Game.fixGameErrors(self.db, self.marketHelper,
                                                    self.steamHelper, self.info, self.logger, callback);
                                            });
                                        });
                                    });
                                });
                            }, timeout > 0 ? timeout : 0);
                        });

                    });
                });
            });
        });
    });
};

Game.prototype.getAllItems = function (callback) {
    var self = this;
    var items = [];
    var numBetsByPlayer = {};
    async.forEachOfSeries(self.bets, function (bet, key, cbf) {
        var owner = bet.steamID;
        if (numBetsByPlayer[owner]) {
            numBetsByPlayer[owner]++;
        } else {
            numBetsByPlayer[owner] = 1;
        }
        async.forEachOfSeries(bet.items, function (item, key0, cb) {
            item.owner = owner;
            items.push(item);
            cb();
        }, function () {
            cbf();
        });
    }, function () {
        callback(items, numBetsByPlayer);
    });
};

Game.prototype.getUserToken = function (steamID, callback, numRetries) {
    var self = this;
    self.db.collection('users').find({steamID: steamID}).toArray(function (err, users) {
        if (err) {
            self.logger.error(err.stack || err);
            if (!numRetries)
                numRetries = 1;
            else
                numRetries++;
            if (numRetries < MAX_RETRIES)
                setTimeout(function () {
                    self.getToken(steamID, callback, numRetries);
                }, RETRY_INTERVAL / 2);
            else
                self.emit('fatalError');
        } else {
            if (!users) {
                callback(null);
            } else if (!users[0]) {
                callback(null);
            } else if (!users[0].token) {
                callback(null);
            } else {
                callback(users[0].token);
            }
        }
    });
};

Game.prototype.sortWonItems = function (user, callback) {
    var self = this;
    self.steamHelper.loadMyInventory(self.info.appID, function (items) {
        var itemsToSend = [];
        self.getAllItems(function (gameItems) {
            self.emit('calcFee', user, function (multiplier) {
                var feeSize = self.currentBank * multiplier;
                var totalFee = feeSize;
                var feeItems = 0;
                gameItems.sort(function (a, b) {
                    return (a.cost > b.cost) ? 1 : ((b.cost > a.cost) ? -1 : 0);
                });
                async.forEachOfSeries(gameItems, function (item, key, cb) {
                    var inventoryItem = items.filter(function (o) {
                        return o.id === item.id;
                    });
                    if (inventoryItem && inventoryItem[0]) {
                        inventoryItem = inventoryItem[0];
                        if (item.cost <= feeSize && item.owner !== user.steamID.getSteamID64()) {
                            feeSize -= item.cost;
                            feeItems++;
                        } else {
                            inventoryItem.cost = item.cost;
                            itemsToSend.push(inventoryItem);
                        }
                        cb();
                    } else {
                        cb();
                    }
                }, function () {
                    totalFee = ((totalFee - feeSize) / 100).toFixed(2);
                    self.logger.info('game.fee', {
                        "%i%": feeItems,
                        "%d%": totalFee
                    }, NotificationType.INFO);
                    callback(itemsToSend);
                });
            });
        });
    });
};

Game.prototype.submit = function (winner, percentage, callback) {
    var self = this;
    self.db.collection('games').updateOne({id: self.id}, {
        $set: {
            winner: winner.steamID.getSteamID64(),
            winnerName: winner.name,
            percentage: percentage,
            winnerAvatar: winner.getAvatarURL('full')
        }
    }, {w: 1}, function (err) {
        if (err) {
            self.logger.error(err.stack || err);
            setTimeout(function () {
                self.submit(winner, percentage, callback);
            }, RETRY_INTERVAL / 2);
        } else {
            self.db.collection('users').updateOne({steamID: winner.steamID.getSteamID64()}, {
                $inc: {
                    won: 1,
                    totalIncome: self.currentBank
                },
                $max: {
                    maxWin: self.currentBank
                }
            }, function (err1) {
                if (err1) {
                    self.logger.error(err1.stack || err1);
                    setTimeout(function () {
                        self.submit(winner, percentage, callback);
                    }, RETRY_INTERVAL / 2);
                } else {
                    self.emit('updateProfile', winner.steamID.getSteamID64());
                    self.updateUserStats(function () {
                        self.updateGlobalStats(function (stats) {
                            callback(stats);
                        })
                    });
                }
            });
        }
    });
};

Game.prototype.updateUserStats = function (callback) {
    var self = this;
    self.db.collection('users').updateMany({steamID: {$in: Object.keys(self.betsByPlayer)}},
        {$inc: {totalGames: 1}}, {w: 1}, function (err1) {
            if (err1) {
                self.logger.error(err1.stack || err1);
                setTimeout(function () {
                    self.updateUserStats(callback);
                }, RETRY_INTERVAL / 2);
            } else {
                callback();
            }
        });
};

Game.prototype.updateGlobalStats = function (callback) {
    var self = this;
    self.updateJackpot(function (jackpot) {
        self.updateGamesToday(function (games) {
            self.updateItemsToday(games, function (itemsCount) {
                var result = {jackpot: jackpot, gamesToday: games.length, itemsToday: itemsCount};
                self.emit('updateStats', result);
                callback(result);
            });
        });
    });
};

Game.prototype.updateGamesToday = function (callback) {
    var self = this;
    var date = new Date();
    date.setHours(0, 0, 0, 0);
    var timeCutoff = date.getTime();
    self.db.collection('games').find({startTime: {$gt: timeCutoff}}).toArray(function (err, games) {
        if (err) {
            self.logger.error(err.stack || err);
            setTimeout(function () {
                self.updateGamesToday(callback);
            }, RETRY_INTERVAL / 2);
        } else {
            callback(games);
        }
    });
};

Game.prototype.updateItemsToday = function (games, callback) {
    var itemsCount = 0;
    async.forEachOfSeries(games, function (game, index, cb) {
        itemsCount += game.numItems;
        cb();
    }, function () {
        callback(itemsCount);
    });
};

Game.prototype.updateJackpot = function (callback) {
    var self = this;
    if (self.currentBank > self.info.jackpot) {
        self.db.collection('info').updateOne({name: 'jackpot'},
            {$set: {value: self.currentBank}}, function (err) {
                if (err) {
                    self.logger.error(err.stack || err);
                    setTimeout(function () {
                        self.updateJackpot(callback);
                    }, RETRY_INTERVAL / 2);
                } else {
                    callback(self.currentBank);
                }
            });
    } else {
        callback(self.info.jackpot);
    }
};

Game.prototype.sendWonItems = function (items, winner, token, callback) {
    var self = this;
    if (token === null)
        self.getUserToken(winner.steamID.getSteamID64(), function (userToken) {
            self.steamHelper.sendItems(winner.steamID.getSteamID64(), userToken, items, self.logger.toLocal('game.jackpot', {
                "%id%": self.id,
                "%site%": self.info.domain
            }), callback);
        });
    else {
        self.steamHelper.sendItems(winner.steamID.getSteamID64(), token, items, self.logger.toLocal('game.jackpot', {
            "%id%": self.id,
            "%site%": self.info.domain
        }), callback);
    }
};

Game.prototype.update = function (callback) {
    var self = this;
    self.db.collection('games').updateOne({id: self.id}, {
        $set: {
            bank: self.currentBank,
            numItems: self.numItems
        }
    }, {w: 1}, function (err) {
        if (err) {
            self.logger.error('game.error.update');
            setTimeout(function () {
                self.update(callback);
            }, RETRY_INTERVAL / 10);
        } else {
            self.sortBetsByPlayer(function () {
                self.recalculateChance(function () {
                    if (self.state === State.WAITING && Object.keys(self.betsByPlayer).length >= 2) {
                        var start = Date.now();
                        self.db.collection('games').updateOne({id: self.id}, {$set: {startTime: start}}, {w: 1}, function (err1) {
                            if (err1) {
                                self.logger.error('game.error.update');
                                setTimeout(function () {
                                    self.update(callback);
                                }, RETRY_INTERVAL / 10);
                            } else {
                                self.startTime = start;
                                if (self.gameTimer <= 0)
                                    self.gameTimer = self.info.gameDuration;
                                self.startTimer();
                                self.emit('updated');
                                if (callback)
                                    callback();
                            }
                        });
                    } else if (self.state === State.PAUSED && Object.keys(self.betsByPlayer).length >= 2) {
                        if (self.gameTimer <= 0)
                            self.gameTimer = self.info.gameDuration;
                        self.setState(State.ACTIVE, function () {
                            self.startTimer();
                            self.emit('updated');
                            if (callback)
                                callback();
                        });
                    } else {
                        if (self.numItems === self.info.maxItems) {
                            self.emit('updated');
                            self.roll(function () {
                                self.emit('updated');
                                callback();
                            });
                        } else if (self.state === State.PAUSED) {
                            self.gameTimer = self.info.gameDuration;
                            self.setState(State.WAITING, function () {
                                self.emit('updated');
                                callback();
                            });
                        } else {
                            self.emit('updated');
                            if (callback)
                                callback();
                        }
                    }
                })
            });
        }
    });
};

Game.prototype.resume = function (data, callback) {
    var self = this;
    self.state = data.state;
    self.sortBetsByPlayer(function () {
        if (self.state === State.ERROR) {
            self.steamHelper.getSteamUser(data.winner, function (user) {
                self.sortWonItems(user, function (items) {
                    self.setState(State.SENDING, function () {
                        self.sendWonItems(items, user, null, function (offer, err) {
                            if (err) {
                                self.setState(State.ERROR, function () {
                                    var newGame = new Game(self.id + 1, self.db, self.marketHelper, self.steamHelper,
                                        self.info, self.logger);
                                    self.emit('newGame', newGame);
                                    callback();
                                });
                            } else {
                                self.setState(State.SENT, function () {
                                    var newGame = new Game(self.id + 1, self.db, self.marketHelper, self.steamHelper,
                                        self.info, self.logger);
                                    self.emit('newGame', newGame);
                                    callback();
                                });
                            }
                        });
                    });
                });
            });

        } else if (self.state === State.ROLLING || self.state === State.SENDING) {
            self.winner = data.winner;
            self.selectWinner(function (winnerID) {
                self.winner = winnerID;
                self.steamHelper.getSteamUser(winnerID, function (user) {
                    self.sortWonItems(user, function (items) {
                        self.setState(State.SENDING, function () {
                            self.sendWonItems(items, user, null, function (offer, err) {
                                if (err) {
                                    self.setState(State.ERROR, function () {
                                        self.submit(user, self.betsByPlayer[winnerID].chance, function () {
                                            var newGame = new Game(self.id + 1, self.db, self.marketHelper, self.steamHelper,
                                                self.info, self.logger);
                                            self.emit('newGame', newGame);
                                            callback();
                                        });
                                    });
                                } else {
                                    self.submit(user, self.betsByPlayer[winnerID].chance, function () {
                                        self.setState(State.SENT, function () {
                                            var newGame = new Game(self.id + 1, self.db, self.marketHelper, self.steamHelper,
                                                self.info, self.logger);
                                            self.emit('newGame', newGame);
                                            callback();
                                        });
                                    });
                                }
                            });
                        });
                    });
                });
            });
        } else {
            self.winner = data.winner;
            self.currentBank = data.bank;
            self.bets = data.bets;
            self.float = data.float;
            self.hash = data.hash;
            self.startTime = data.startTime;
            if (self.state === State.PAUSED) {
                self.gameTimer = data.pauseTimer;
                callback();
            } else if (data.startTime > 0) {
                if (Date.now() - data.startTime >= self.info.gameDuration * 1000) {
                    self.roll(callback);
                } else {
                    self.gameTimer = Math.max(1, Number(((Date.now() - data.startTime) / 1000).toFixed(0)));
                    self.startTimer();
                    callback();
                }
            } else if (Object.keys(self.betsByPlayer).length >= 2) {
                self.update(callback);
            }
        }
    });
};

Game.prototype.processQueuedBets = function() {
    var self = this;
    async.forEachOfSeries(self.betsQueue, function(bet, key, callback) {
        self.update(function () {
            self.emit('newBet', bet);
            callback();
        });
    }, function() {
        self.betsQueue = [];
    });
};

Game.prototype.startTimer = function () {
    var self = this;
    if (self.state !== State.PAUSED) {
        self.setState(State.ACTIVE, function () {
            self.timerID = setInterval(function () {
                if (self.betsQueue.length === 0) {
                    self.gameTimer--;
                    self.emit('timerChanged', self.gameTimer);
                    if (self.gameTimer <= 0) {
                        clearInterval(self.timerID);
                        self.roll();
                    }
                }
            }, 1000);
        });
    }
};

module.exports = Game;
