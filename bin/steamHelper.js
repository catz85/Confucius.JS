/**
 * Created by BronzeBee on 12.05.2016.
 */

var SteamCommunity = require('steamcommunity');
var SteamUser = require('steam-user');
var async = require('async');
var events = require('events');
var SteamTotp = require('steam-totp');
var TradeOfferManager = require('steam-tradeoffer-manager');
var fs = require('fs');
var util = require('util');

util.inherits(SteamHelper, events.EventEmitter);

const MAX_RETRIES = 5;
const RETRY_INTERVAL = 3000;


function SteamHelper(accountDetails, marketHelper, logger) {
    this.steamUser = new SteamUser();
    this.tradeOfferManager = null;
    this.steamCommunity = new SteamCommunity();
    this.marketHelper = marketHelper;
    this.accountDetails = accountDetails;
    this.logger = logger ? logger : {
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
    this.doingForceCheck = false;
    this.loggedIn = false;
    this.tempData = {};
    this.setUpListeners();
}

SteamHelper.prototype.login = function (callback) {
    var self = this;
    var details = self.accountDetails;
    self.tempData.authCallback = callback;
    self.logger.info('steam.user', {"%user%": details.accountName});
    details.twoFactorCode = SteamTotp.generateAuthCode(details.sharedSecret);
    self.logger.info('steam.loggingIn');
    self.steamUser.setSentry(fs.readFileSync(details.sentry));
    setTimeout(function () {
        if (!self.loggedIn) {
            self.logger.error('steam.error.login');
            self.terminate();
        }
    }, RETRY_INTERVAL * 2);
    self.steamUser.logOn(details);
}

SteamHelper.prototype.terminate = function () {
    var self = this;
    self.emit('terminate');
}

SteamHelper.prototype.loadMyInventory = function (appID, callback, numRetries) {
    var self = this;
    self.tradeOfferManager.loadInventory(appID, 2, true, function (err, items) {
        if (err) {
            self.logger.error('steam.error.inventory');
            self.logger.error(err.stack || err);
            if (!numRetries)
                numRetries = 1;
            else
                numRetries++;
            if (numRetries < MAX_RETRIES)
                setTimeout(function () {
                    self.loadMyInventory(appID, callback, numRetries);
                }, RETRY_INTERVAL / 2);
            else {
                self.logger.error('steam.error.inventoryRetries', {"%i%": MAX_RETRIES});
                self.terminate();
            }
        } else {
            callback(items);
        }
    });
}

SteamHelper.prototype.setUpListeners = function () {
    var self = this;

    self.steamUser.on('loggedOn', function () {
        self.loggedIn = true;
        self.steamUser.setPersona(SteamUser.Steam.EPersonaState.LookingToTrade);
        self.emit('loggedIn');
    });

    self.steamUser.on('webSession', function (sessionID, cookies) {
        if (self.loggedIn) {
            self.tradeOfferManager = new TradeOfferManager({
                "steam": self.steamUser,
                "community": self.steamCommunity,
                "domain": self.accountDetails['domain'],
                "language": 'en'
            });

            self.tradeOfferManager.on('newOffer', function (offer) {
                if (!self.doingForceCheck)
                    self.emit('autoOffer', offer);
            });
        }

        self.tradeOfferManager.setCookies(cookies, function (err) {
            if (err) {
                self.logger.error('error.steam.apiKey');
                self.logger.error(err.stack || err);
                self.terminate();
                return;
            } else {
                self.logger.info('steam.apiKey', {"%s%": self.tradeOfferManager.apiKey});
                self.steamCommunity.setCookies(cookies);
                if (!self.loggedIn) {
                    self.loggedIn = true;
                } else {
                    self.steamCommunity.startConfirmationChecker(30000, self.accountDetails['identitySecret']);
                    self.steamCommunity.on('sessionExpired', function (err) {
                        self.logger.error('steam.error.expired');
                        self.logger.error('steam.error.re-login');
                        self.logger.error(err.stack || err);
                        self.loggedIn = false;
                        setTimeout(function () {
                            var tID = setInterval(function () {
                                if (!self.loggedIn) {
                                    self.steamUser.webLogOn();
                                } else {
                                    clearInterval(tID);
                                }
                            }, RETRY_INTERVAL);
                        }, RETRY_INTERVAL);
                    });
                    self.tempData.authCallback();
                }
            }
        });

    });
}

SteamHelper.prototype.sendItems = function (user, token, items, msg, callback, numRetries) {
    var self = this;
    var offer = self.tradeOfferManager.createOffer(user);
    offer.addMyItems(items);
    offer.send(msg, token, function (err, result) {
        if (!err) {
            callback(offer);
        } else {
            if (!numRetries)
                numRetries = 1;
            else
                numRetries++;
            self.logger.error('error.steam.sendTrade');
            self.logger.error(err.stack || err);
            if (numRetries < MAX_RETRIES) {
                setTimeout(function () {
                    self.sendItems(user, token, items, msg, callback, numRetries);
                }, RETRY_INTERVAL);
            } else {
                self.logger.error('steam.error.sendTradeRetries', {"%i%": MAX_RETRIES});
                callback(null, err);
            }
        }
    });
}

SteamHelper.prototype.getTradeOffers = function (filter, callback, numRetries) {
    var self = this;
    if (!callback)
        callback = function (arg0, arg1) {
            return;
        };
    self.tradeOfferManager.getOffers(filter, null, function (err, sentOffers, receivedOffers) {
        if (err) {
            if (!numRetries || numRetries === 0)
                numRetries = 1;
            else
                numRetries++;
            self.logger.error('steam.error.loadOffers');
            self.logger.error(err.stack || err);
            if (numRetries < MAX_RETRIES) {
                self.logger.error('error.retrying');
                setTimeout(function () {
                    self.getActiveSentTrades(callback, numRetries);
                }, RETRY_INTERVAL / 2);
            } else {
                self.logger.error('steam.error.loadOffersRetries', {"%i%": MAX_RETRIES});
                self.terminate();
            }
        } else {
            callback(sentOffers, receivedOffers);
        }
    });
}

SteamHelper.prototype.forceCheckTradeOffers = function (callback) {
    var self = this;
    self.doingForceCheck = true;
    if (!callback)
        callback = function () {
            return;
        };
    self.getTradeOffers(1, function (sentOffers, receivedOffers) {
        async.forEachOfSeries(receivedOffers, function (offer, key, cb) {
            if (offer.state === 2) {
                self.emit('forceOffer', offer);
            }
            cb();
        }, function () {
            self.doingForceCheck = false;
            callback();
        });
    });
}

SteamHelper.prototype.getActiveSentTrades = function (callback) {
    var self = this;
    if (!callback)
        callback = function (arg0) {
            return;
        };
    self.getTradeOffers(1, function (sentOffers) {
        var trades = [];
        async.forEachOfSeries(sentOffers, function (offer, key, cb) {
            if (offer.state === 2) {
                self.getSteamUser(offer.partner.getSteamID64(), function (user) {
                    trades.push({
                        offerID: offer.id,
                        receiverName: user.name,
                        receiverID: offer.partner.getSteamID64(),
                        number: offer.itemsToGive.length
                    });
                    cb();
                });
            } else {
                cb();
            }
        }, function () {
            callback(trades);
        });
    });
}

SteamHelper.prototype.acceptTradeOffer = function (offer, callback, numRetries) {
    var self = this;
    if (!callback)
        callback = function (arg0) {
            return;
        };
    offer.accept(function (err) {
        if (err) {
            self.logger.error('steam.error.acceptOffer');
            self.logger.error(err.stack || err);
            if (!numRetries || numRetries === 0)
                numRetries = 1;
            else
                numRetries++;
            if (numRetries < MAX_RETRIES) {
                self.logger.error('Пытаюсь снова');
                setTimeout(function () {
                    self.tradeOfferManager.getOffer(offer.id, function (err, newOffer) {
                        if (err) {
                            self.acceptTradeOffer(offer, callback, numRetries);
                        } else {
                            self.acceptTradeOffer(newOffer, callback, numRetries);
                        }
                    });

                }, RETRY_INTERVAL / 2);
            } else {
                self.logger.error('steam.error.acceptOfferRetries', {"%i%": MAX_RETRIES});
                self.emit('acceptingError', offer);
            }
        } else {
            offer.getReceivedItems(false, function (err, newItems) {
                async.forEachOfSeries(newItems, function (i, k, cbf) {
                    i.owner = offer.partner.getSteamID64();
                    i.cost = self.marketHelper.getItemData(i.market_hash_name).value;
                    cbf();
                }, function () {
                    self.steamCommunity.checkConfirmations();
                    callback(newItems);
                });
            });

        }
    });
}

SteamHelper.prototype.declineTradeOffer = function (offer, callback, numRetries) {
    var self = this;
    if (!callback)
        callback = function (arg0) {
        };
    offer.decline(function (err) {
        if (err) {
            self.logger.error('steam.error.declineOffer');
            self.logger.error(err.stack || err);
            if (!numRetries || numRetries === 0)
                numRetries = 1;
            else
                numRetries++;
            if (numRetries < MAX_RETRIES) {
                self.logger.error('error.retrying');
                setTimeout(function () {
                    self.tradeOfferManager.getOffer(offer.id, function (err, updatedOffer) {
                        if (err) {
                            self.declineTradeOffer(offer, callback, numRetries);
                        } else {
                            self.declineTradeOffer(updatedOffer, callback, numRetries);
                        }
                    });
                }, RETRY_INTERVAL);
            } else {
                self.logger.error('steam.error.declineOfferRetries', {"%i%": MAX_RETRIES});
                self.terminate();
            }
        } else {
            callback();
        }
    });
}

SteamHelper.prototype.getLastReceivedItems = function (timeCutoff, callback, numRetries) {
    var self = this;
    self.getTradeOffers(2, function (sentOffers, receivedOffers) {
        var lastItems = [];
        var totalCost = 0;
        async.forEachOfSeries(receivedOffers, function (offer, key, cb) {
            if (offer.state === 3 && offer.updated.getTime() >= timeCutoff) {
                offer.getReceivedItems(false, function (err, newItems) {
                    if (err) {
                        self.logger.error('steam.error.loadItems');
                        self.logger.error(err.stack || err);
                        if (numRetries || numRetries === 0)
                            numRetries = 1;
                        else
                            numRetries++;
                        if (numRetries < MAX_RETRIES) {
                            self.logger.error('error.retrying');
                            setTimeout(function () {
                                self.getLastReceivedItems(timeCutoff, callback, numRetries);
                            }, RETRY_INTERVAL);
                        } else {
                            self.logger.error('steam.error.loadItemsRetries', {"%i%": MAX_RETRIES});
                            self.terminate();
                        }
                    } else {
                        var items = [];
                        var cost = 0;
                        async.forEachOfSeries(newItems, function (item, key, cbf) {
                            item.cost = self.marketHelper.getItemData(item.market_hash_name).value;
                            totalCost += item.cost;
                            cost += item.cost;
                            items.push(item);
                            cbf();
                        }, function () {
                            lastItems.push({
                                owner: offer.partner.getSteamID64(),
                                totalCost: cost,
                                items: items
                            });
                            cb();
                        });
                    }
                });
            } else {
                cb();
            }
        }, function () {
            if (callback)
                callback(lastItems, totalCost);
        });
    });
}

SteamHelper.prototype.getSteamUser = function (steamID64, callback, numRetries) {
    var self = this;
    if (!callback)
        callback = function (arg0) {
            return;
        };
    self.steamCommunity.getSteamUser(new SteamCommunity.SteamID(steamID64), function (err, user) {
        if (err) {
            self.logger.error('steam.error.userData', {"%s%": steamID64});
            self.logger.error(err.stack || err);
            if (!numRetries || numRetries === 0)
                numRetries = 1;
            else
                numRetries++;
            if (numRetries < MAX_RETRIES) {
                self.logger.error('Пытаюсь снова');
                setTimeout(function () {
                    self.getSteamUser(steamID64, callback, numRetries);
                }, 3000);
            } else {
                self.logger.error('steam.error.userDataRetries', {"%i%": MAX_RETRIES, "%s%": steamID64});
                self.terminate();
            }
        } else {
            callback(user);
        }
    });
}

module.exports = SteamHelper;