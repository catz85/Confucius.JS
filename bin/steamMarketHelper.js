/**
 * Created by BronzeBee on 10.05.2016.
 */

var request = require('request');
var fs = require('fs');

const FILE_NAME = './prices.json';
const WEB_URL = 'http://backpack.tf/api/IGetMarketPrices/v1/?format=json&appid=';
const RETRY_INTERVAL = 3000;

function MarketHelper(APIKey, appID, updateInterval, logger) {
    var self = this;
    this.APIKey = APIKey;
    this.appID = appID;
    this.taskID = -1;
    this.priceData = {};
    this.updateInterval = updateInterval * 1000;
    this.logger = logger ? logger : {
        error: function (msg) {
            console.log(msg);
        }, info: function (msg) {
            console.log(msg);
        }
    }
}

MarketHelper.prototype.start = function(callback) {
    var self = this;

    if (fs.existsSync(FILE_NAME)) {
        var data = JSON.parse(fs.readFileSync(FILE_NAME, 'utf-8'));
        self.priceData = data.items;
        self.lastUpdate = data.last_update;
        if (Date.now() - self.lastUpdate >= self.updateInterval) {
            self.cachePrices(callback);
        } else {
            if (callback)
                callback();
        }
    } else {
        self.lastUpdate = 0;
        self.cachePrices(callback);
    }
}

MarketHelper.prototype.getItemData = function (marketHashName) {
    return this.priceData[marketHashName];
}

MarketHelper.prototype.cachePrices = function (callback) {
    var self = this;
    self.logger.info('Идет кэширование цен, может занять до 1 минуты');
    var url = WEB_URL + self.appID + '&key=' + self.APIKey;
    request(url, function (err, response, body) {
        if (err) {
            self.logger.error('Не удалось прокэшировать цены');
            self.logger.error(err.stack || err);
            self.logger.error('Повторная попытка через 3с.');
            setTimeout(function () {
                self.cachePrices(callback);
            }, RETRY_INTERVAL);
        } else {
            var data = JSON.parse(body);
            if (Number(data.response.success) === 1) {
                self.priceData = data.response.items;
                self.lastUpdate = Date.now();
                var output = {last_update: self.lastUpdate, items: self.priceData};
                fs.writeFileSync(FILE_NAME, JSON.stringify(output, null, 3), 'utf-8');
                self.logger.info('Цены успешно прокэшированы');
                self.taskID = setTimeout(function () {
                    self.cachePrices();
                }, self.updateInterval);
                if (callback)
                    callback();
            } else {
                self.logger.error('Не удалось прокэшировать цены:');
                self.logger.error(data.response.message);
                self.logger.error('Повторная попытка через 3с.');
                setTimeout(function () {
                    self.cachePrices(callback);
                }, RETRY_INTERVAL);
            }
        }
    });
}

module.exports = MarketHelper;