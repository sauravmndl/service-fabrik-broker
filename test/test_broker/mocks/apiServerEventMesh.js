'use strict';

const _ = require('lodash');
const nock = require('nock');
const config = require('../../../common/config');
const CONST = require('../../../common/constants');
const apiServerHost = `https://${config.apiserver.ip}:${config.apiserver.port}`;


exports.nockLoadSpec = nockLoadSpec;
exports.nockCreateResource = nockCreateResource;
exports.nockPatchResource = nockPatchResource;
exports.nockGetResource = nockGetResource;
exports.nockGetResourceRegex = nockGetResourceRegex;
exports.nockDeleteResource = nockDeleteResource;
exports.nockPatchResourceRegex = nockPatchResourceRegex;
exports.nockGetResourceListByState = nockGetResourceListByState;
exports.nockCreateCrd = nockCreateCrd;
exports.nockPatchCrd = nockPatchCrd;

function nockLoadSpec(times) {
  nock(apiServerHost)
    .get('/swagger.json')
    .times(times || 1)
    .reply(200, {
      paths: {
        '/api/': {
          get: {
            operationId: 'getCoreAPIVersions'
          }
        }
      }
    });
}

function nockCreateCrd(resourceGroup, resourceType, response, times) {
  nock(apiServerHost)
    .post(`/apis/${resourceGroup}/v1beta1/customresourcedefinitions`)
    .times(times || 1)
    .reply(201, response);
}

function nockPatchCrd(resourceGroup, resourceType, response, times, expectedStatusCode) {
  nock(apiServerHost)
    .patch(`/apis/${resourceGroup}/v1beta1/customresourcedefinitions/${resourceType}`)
    .times(times || 1)
    .reply(expectedStatusCode || 200, response);
}


function nockCreateResource(resourceGroup, resourceType, response, times, verifier, expectedStatusCode) {
  nock(apiServerHost)
    .post(`/apis/${resourceGroup}/v1alpha1/namespaces/default/${resourceType}`, verifier)
    .times(times || 1)
    .reply(expectedStatusCode || 201, response);
}

function nockPatchResource(resourceGroup, resourceType, id, response, times, payload, expectedStatusCode) {
  nock(apiServerHost, {
      reqheaders: {
        'content-type': CONST.APISERVER.PATCH_CONTENT_TYPE
      }
    })
    .patch(`/apis/${resourceGroup}/v1alpha1/namespaces/default/${resourceType}/${id}`, payload)
    .times(times || 1)
    .reply(expectedStatusCode || 200, response);
}

function nockGetResourceRegex(resourceGroup, resourceType, response, times, expectedStatusCode) {
  nock(apiServerHost)
    .get(new RegExp(`/apis/${resourceGroup}/v1alpha1/namespaces/default/${resourceType}/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})`))
    .times(times || 1)
    .reply(expectedStatusCode || 200, response);
}

function nockPatchResourceRegex(resourceGroup, resourceType, response, times, verifier, expectedStatusCode) {
  nock(apiServerHost)
    .patch(
      new RegExp(`/apis/${resourceGroup}/v1alpha1/namespaces/default/${resourceType}/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})`),
      verifier)
    .times(times || 1)
    .reply(expectedStatusCode || 200, response);
}

function nockDeleteResource(resourceGroup, resourceType, id, response, times, expectedStatusCode) {
  nock(apiServerHost)
    .delete(`/apis/${resourceGroup}/v1alpha1/namespaces/default/${resourceType}/${id}`)
    .times(times || 1)
    .reply(expectedStatusCode || 200, response);
}

function nockGetResource(resourceGroup, resourceType, id, response, times, expectedStatusCode) {
  nock(apiServerHost)
    .get(`/apis/${resourceGroup}/v1alpha1/namespaces/default/${resourceType}/${id}`)
    .times(times || 1)
    .reply(expectedStatusCode || 200, response);
}

function nockGetResourceListByState(resourceGroup, resourceType, stateList, response, times, expectedStatusCode) {
  nock(apiServerHost)
    .get(`/apis/${resourceGroup}/v1alpha1/namespaces/default/${resourceType}`)
    .query({
      labelSelector: `state in (${_.join(stateList, ',')})`
    })
    .times(times || 1)
    .reply(expectedStatusCode || 200, {
      items: response
    });
}