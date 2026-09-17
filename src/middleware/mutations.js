'use strict';

const express = require('express');
const { transaction } = require('../services/dbService');
const { sortTopics } = require('../services/topicOrderService');
const { getSetting, setSetting } = require('../services/settingsService');

const READ_ONLY = /^\/(export\/|import\/preview$|login$|logout$)/;
const OUTSIDE_SNAPSHOT = /^\/(publish|guest-[a-z]+|move-marks|appearance|password|reset-password|widget-host|room-plan\/settings|guest\/lesson\/\d+|archives(\/[^/]+)?)$/;

function finalizeMutation(req, res) {
  if (req.mutationFinalized || ['GET', 'HEAD', 'OPTIONS'].includes(req.method) || READ_ONLY.test(req.path) || res.statusCode >= 400) return;
  sortTopics();
  const noteOnly = req.method === 'PUT' && /^\/move-log\/\d+$/.test(req.path);
  if (!noteOnly && !OUTSIDE_SNAPSHOT.test(req.path)) setSetting('unpublished', '1');
  setSetting('dataVersion', String(Number(getSetting('dataVersion') || 0) + 1));
  req.mutationFinalized = true;
}

// Synchronous command handlers share one transaction with ordering and versioning.
// Authentication and upload middleware finish BEFORE the transaction starts.
function command(handler) {
  if (handler.constructor.name === 'AsyncFunction') throw new TypeError('Async command requires an explicit transaction boundary');
  return (req, res, next) => {
    const json = res.json;
    let body;
    let replied = false;
    let error;
    const rejected = Symbol('rejected response');
    res.json = (value) => { body = value; replied = true; return res; };
    try {
      transaction(() => {
        handler(req, res, (err) => { error = err || new Error('Command did not send a response'); });
        if (error) throw error;
        if (!replied) throw new Error('Command must send a JSON response synchronously');
        if (res.statusCode >= 400) throw rejected;
        finalizeMutation(req, res);
      });
    } catch (err) {
      if (err !== rejected) error = err;
    } finally {
      res.json = json;
    }
    if (error) return next(error);
    return res.json(body);
  };
}

function commandRouter() {
  const router = express.Router();
  for (const method of ['post', 'put', 'patch', 'delete']) {
    const register = router[method].bind(router);
    router[method] = (path, ...handlers) => register(path, ...handlers.slice(0, -1), command(handlers.at(-1)));
  }
  return router;
}

module.exports = { commandRouter, finalizeMutation };
