'use strict';
const _ = require('lodash'),
  h = require('highland'),
  utils = require('clayutils'),
  yaml = require('js-yaml'),
  config = require('./config'),
  prefixes = require('../prefixes'),
  rest = require('../rest'),
  refProp = '_ref',
  DEFAULT_CONCURRENCY = 10,
  CONCURRENCY_TIME = 100;

/**
 * expand references in component lists
 * @param  {array} val
 * @return {array}
 */
function expandListReferences(val) {
  if (_.has(_.head(val), refProp)) {
    // component list! return the references
    return _.map(val, (item) => item[refProp]);
  } else {
    return [];
  }
}

/**
 * expand references in component properties
 * @param  {object} val
 * @return {array}
 */
function expandPropReferences(val) {
  if (_.has(val, refProp)) {
    return [val[refProp]];
  } else {
    return [];
  }
}

/**
 * list all references in a component
 * @param  {object} data
 * @return {array} of uris
 */
function listComponentReferences(data) {
  return _.reduce(data, (result, val) => {
    if (_.isArray(val)) {
      return result.concat(expandListReferences(val));
    } else if (_.isObject(val)) {
      return result.concat(expandPropReferences(val));
    } else {
      return result;
    }
  }, []);
}

/**
 * throw errors in the same place they can be dealt with
 * @param  {object|Error} item
 * @return {object}
 */
function toError(item) {
  if (item instanceof Error) {
    throw item;
  } else {
    return item;
  }
}

/**
 * push rest errors into the stream
 * @param  {Error} err
 * @param  {function} push
 */
function pushRestError(err, push) {
  push(null, { type: 'error', message: err.url }); // every url that errors out should be captured
}

/**
 * recursively check all references in a component
 * @param  {*} url
 * @param {string} prefix
 * @param  {number} concurrency
 * @return {Stream}
 */
function checkComponent(url, prefix, concurrency) {
  if (_.isObject(url)) {
    return h.of(url); // error / success object, pass it on
  } else if (_.isString(url) && !_.includes(url, 'http')) {
    // uri, convert it to url
    url = prefixes.uriToUrl(prefix, url);
  }

  // first, do a quick check against the composed json
  return rest.get(`${url}.json`)
    .flatMap((res) => {
      if (res instanceof Error) {
        // some child is broken, start the linting process in earnest
        return rest.get(url)
          .map(toError)
          .flatMap((data) => {
            const children = listComponentReferences(data);

            return h([h.of({ type: 'success', message: url }), h(children)]).merge();
          })
          .errors(pushRestError)
          .flatMap((uri) => checkComponent(uri, prefix))
          .ratelimit(concurrency, CONCURRENCY_TIME);
      } else {
        // everything's fine! no need to lint any children
        return h.of({ type: 'success', message: url });
      }
    });
}

/**
 * check all references in a page
 * @param  {string} url
 * @param {string} prefix
 * @param  {number} concurrency
 * @return {Stream}
 */
function checkPage(url, prefix, concurrency) {
  // first, do a quick check against the composed json
  return rest.get(`${url}.json`)
    .flatMap((res) => {
      if (res instanceof Error) {
        // some child is broken, start the linting process in earnest
        return rest.get(url)
          .map(toError)
          .flatMap((data) => {
            const layout = data.layout,
              children = _.reduce(data, (uris, area) => _.isArray(area) ? uris.concat(area) : uris, []);

            return h([h.of({ type: 'success', message: url }), h.of(layout), h(children)]).merge();
          })
          .errors(pushRestError)
          .flatMap((uri) => checkComponent(uri, prefix))
          .ratelimit(concurrency, CONCURRENCY_TIME);
      } else {
        // everything's fine! no need to lint any children
        return h.of({ type: 'success', message: url });
      }
    });
}

/**
 * determine the page uri, then run checks against it
 * @param  {string} url
 * @param  {number} concurrency
 * @return {Stream}
 */
function checkPublicUrl(url, concurrency) {
  return rest.findURI(url)
    .map(toError)
    .flatMap(({ uri, prefix }) => {
      const pageURL = prefixes.uriToUrl(prefix, uri);

      return h([h.of({ type: 'success', message: url }), checkPage(pageURL, prefix, concurrency)]).merge();
    }).errors(pushRestError);
}

/**
 * lint a url, recursively determining if all components exist
 * @param  {string} rawUrl url or alias, will be run through config
 * @param  {object} options
 * @return {Stream}
 */
function lintUrl(rawUrl, options = {}) {
  const concurrency = options.concurrency || DEFAULT_CONCURRENCY,
    url = config.get('url', rawUrl);

  if (!url) {
    // exit early if there's no url
    return h.of({ type: 'error', message: 'URL is not defined! Please specify a url to lint' });
  }

  if (utils.isComponent(url)) {
    return checkComponent(url, prefixes.getFromUrl(url), concurrency);
  } else if (utils.isPage(url)) {
    return checkPage(url, prefixes.getFromUrl(url), concurrency);
  } else {
    return checkPublicUrl(url, concurrency);
  }
}

/**
 * determine if a schema has a description
 * @param  {object} obj
 * @return {boolean}
 */
function noDescription(obj) {
  return !_.has(obj, '_description');
}

/**
 * check camelCase, but more flexible than lodash's algorithm
 * @param  {string}  str
 * @return {Boolean}
 */
function isCamelCased(str) {
  const camel = _.camelCase(str);

  // note: we're lowercasing everything because we don't care about 100% perfect camelCase (e.g. imageURL is valid),
  // we just want to make sure that people aren't using weird characters that cannot be used as properties in dot notation
  return str.toLowerCase() === camel.toLowerCase() || str.toLowerCase() === `_${camel}`.toLowerCase(); // lodash's camelCase() will remove leading underscores, which we allow in things like _version, _description, and _devDescription
}

/**
 * determine if a schema has camelCased props
 * @param  {obj} obj
 * @return {array}
 */
function nonCamelCasedProps(obj) {
  return _.reduce(obj, (errors, value, key) => {
    return !isCamelCased(key) ? errors.concat(key) : errors;
  }, []);
}

/**
 * determine if a schema has groups that reference non-existant fields
 * @param  {obj} obj
 * @return {array}
 */
function nonexistentGroupFields(obj) {
  return _.reduce(_.get(obj, '_groups'), (errors, group, groupName) => {
    const fields = group.fields;

    _.each(fields, (field) => {
      if (!_.has(obj, field)) {
        errors.push(`${groupName} » ${field}`);
      }
    });
    return errors;
  }, []);
}

/**
 * lint schemas for:
 * - valid yaml syntax
 * - has _description
 * - all root-level properties are camelCase
 * - _group fields refer to existing properties
 * @param  {string} str of yaml
 * @return {Stream}
 */
function lintSchema(str) {
  return h([str])
    .map(yaml.safeLoad)
    .errors((e, push) => {
      push(null, { type: 'error', message: `YAML syntax error: ${e.message.slice(0, e.message.indexOf(':'))}` });
    }).flatMap((obj) => {
      if (obj.type && obj.type === 'error') {
        return h.of(obj); // pass through errors
      } else {
        let errors = [];

        // lint schema!
        if (noDescription(obj)) {
          errors.push({ type: 'error', message: 'Schema has no _description' });
        }

        if (nonCamelCasedProps(obj).length) {
          errors.push({ type: 'error', message: 'Properties must be camelCased', details: nonCamelCasedProps(obj).join('\n') });
        }

        if (nonexistentGroupFields(obj).length) {
          errors.push({ type: 'error', message: 'Fields referenced by groups don\'t exist', details: nonexistentGroupFields(obj).join('\n') });
        }

        if (errors.length) {
          return h(errors);
        } else {
          return h.of({ type: 'success' });
        }
      }
    });
}

module.exports.lintUrl = lintUrl;
module.exports.lintSchema = lintSchema;
