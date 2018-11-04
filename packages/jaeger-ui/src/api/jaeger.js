/* eslint-disable no-param-reassign */
// Copyright (c) 2017 Uber Technologies, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import fetch from 'isomorphic-fetch';
import moment from 'moment';
import queryString from 'query-string';

import prefixUrl from '../utils/prefix-url';

// export for tests
export function getMessageFromError(errData, status) {
  if (errData.code != null && errData.msg != null) {
    if (errData.code === status) {
      return errData.msg;
    }
    return `${errData.code} - ${errData.msg}`;
  }
  try {
    return JSON.stringify(errData);
  } catch (_) {
    return String(errData);
  }
}

function getJSON(url, options = {}) {
  const { query, ...init } = options;
  init.credentials = 'same-origin';
  const queryStr = query ? `?${queryString.stringify(query)}` : '';
  return fetch(`${url}${queryStr}`, init).then(response => {
    if (response.status < 400) {
      return response.json();
    }
    return response.text().then(bodyText => {
      let data;
      let bodyTextFmt;
      let errorMessage;
      try {
        data = JSON.parse(bodyText);
        bodyTextFmt = JSON.stringify(data, null, 2);
      } catch (_) {
        data = null;
        bodyTextFmt = null;
      }
      if (data && Array.isArray(data.errors) && data.errors.length) {
        errorMessage = data.errors.map(err => getMessageFromError(err, response.status)).join('; ');
      } else {
        errorMessage = bodyText || `${response.status} - ${response.statusText}`;
      }
      if (typeof errorMessage === 'string') {
        errorMessage = errorMessage.trim();
      }
      const error = new Error(`HTTP Error: ${errorMessage}`);
      error.httpStatus = response.status;
      error.httpStatusText = response.statusText;
      error.httpBody = bodyTextFmt || bodyText;
      error.httpUrl = url;
      error.httpQuery = typeof query === 'string' ? query : queryString.stringify(query);
      throw error;
    });
  });
}

function transformLogs(span) {
  return !span.annotations ? [] : span.annotations.map(annotation => {
    const value = annotation.value;
    let fieldsValue = value;
    const regex = /(\s?((\S+)=))/gi;
    let match = regex.exec(value);
    while (match != null) {
      const key = match[3];
      fieldsValue = fieldsValue.replace(match[0], `__$key$__${key}=`);
      match = regex.exec(value);
    }
    const fields = fieldsValue.split('__$key$__').slice(1).map(prop => {
      const t = prop.split('=');
      return {
        key: t[0],
        value: t[1],
      };
    });
    return {
      timestamp: annotation.timestamp,
      fields,
    };
  });
}

function transformTags(span) {
  return !span.tags ? [] : Object.entries(span.tags).map(tag => ({
    key: tag[0],
    value: tag[1],
  }));
}

function transformReferences(span) {
  return !span.parentId ? [] : [{
    refType: span.kind === 'CONSUMER' ? 'FOLLOWS_FROM' : 'CHILD_OF',
    traceID: span.traceId,
    spanID: span.parentId,
  }];
}

function transformTraceData(trace) {
  const traceData = {
    traceID: trace[0].traceId,
  };
  traceData.spans = trace.map(span => ({
    spanID: span.id,
    traceID: span.traceId,
    processID: span.localEndpoint.serviceName,
    operationName: span.name,
    startTime: span.timestamp,
    duration: span.duration,
    logs: transformLogs(span),
    tags: transformTags(span),
    references: transformReferences(span),
  }));
  traceData.processes = {};
  trace.forEach(span => {
    const localEndpoint = span.localEndpoint;
    const name = localEndpoint.serviceName;
    traceData.processes[name] = {
      serviceName: name,
      tags: [
        {
          key: 'hostname',
          type: 'string',
          value: name,
        },
        {
          key: 'ip',
          type: 'string',
          value: localEndpoint.ipv4,
        },
      ],
    };
  });
  return traceData;
}

function transformTracesData(traces: Array) {
  // build a map of spanId -> traceId relationships
  // const rels = {};
  // traces.forEach(trace => {
  //   trace.forEach(span => {
  //     rels[span.id] = span.traceId;
  //   });
  // });

  return traces.map(trace => transformTraceData(trace));
}

export const DEFAULT_API_ROOT = prefixUrl('/api/v2/');
export const DEFAULT_DEPENDENCY_LOOKBACK = moment.duration(1, 'weeks').asMilliseconds();

function durationToMs(duration: string, nanos: boolean = false) {
  if (!duration) {
    return null;
  }
  const re = /([0-9]+)([a-z]+)/gmi;
  const rs = re.exec(duration);
  // [0]: 500us - matched
  // [1]: 500   - value
  // [2]: us    - unit
  if (rs && rs.length === 3) {
    const value = rs[1];
    const unit = rs[2];
    let ms = moment.duration(parseInt(value, 10), unit).asMilliseconds();
    ms = nanos ? ms * 1000 : ms;
    // zipkin api seems to have some trouble when duration is not positive
    return ms > 0 ? ms : null;
  }
  return null;
}

const JaegerAPI = {
  apiRoot: DEFAULT_API_ROOT,
  fetchTrace(id) {
    const json = getJSON(`${this.apiRoot}trace/${id}`);
    return json.then(d => ({
      'data': [transformTraceData(d)],
    }));
  },
  fetchTraces(ids) {
    const traces = ids.traceID.map(id => getJSON(`${this.apiRoot}trace/${id}`).then(d => transformTraceData(d)));
    return Promise.all(traces).then(result => ({ 'data': result }));
  },
  archiveTrace(id) {
    return getJSON(`${this.apiRoot}archive/${id}`, { method: 'POST' });
  },
  searchTraces(query) {
    // transform to zipkin query
    const zipkinQuery = {
      spanName: query.operation,
      minDuration: durationToMs(query.minDuration, true),
      maxDuration: durationToMs(query.maxDuration, true),
      endTs: query.end / 1000,
      limit: query.limit,
      annotationQuery: query.tags,
    };
    if (query.lookback) {
      zipkinQuery.lookback = durationToMs(query.lookback);
    }
    if (query.service !== 'all') {
      zipkinQuery.serviceName = query.service;
    }
    query = zipkinQuery;
    const json = getJSON(`${this.apiRoot}traces`, { query });
    return json.then(d => ({
      'data': transformTracesData(d),
    }));
  },
  fetchServices() {
    const json = getJSON(`${this.apiRoot}services`);
    return json.then(d => ({
      'data': d,
    }));
  },
  fetchServiceOperations(serviceName) {
    const json = getJSON(`${this.apiRoot}spans?serviceName=${encodeURIComponent(serviceName)}`);
    return json.then(d => ({
      'data': d,
    }));
  },
  fetchDependencies(endTs = new Date().getTime(), lookback = DEFAULT_DEPENDENCY_LOOKBACK) {
    return getJSON(`${this.apiRoot}dependencies`, { query: { endTs, lookback } });
  },
};

export default JaegerAPI;
