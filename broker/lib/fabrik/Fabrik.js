'use strict';

const assert = require('assert');
const Promise = require('bluebird');
const config = require('../../../common/config');
const catalog = require('../../../common/models').catalog;
const Agent = require('../../../data-access-layer/service-agent');
const VirtualHostAgent = require('./VirtualHostAgent');
const DirectorManager = require('./DirectorManager');
const VirtualHostManager = require('./VirtualHostManager');
const ServiceFabrikOperation = require('./ServiceFabrikOperation');
const DBManager = require('./DBManager');
const OobBackupManager = require('./OobBackupManager');
const BasePlatformManager = require('./BasePlatformManager');
const CONST = require('../../../common/constants');
const DockerManager = config.enable_swarm_manager ? require('./DockerManager') : undefined;

class Fabrik {
  static createManager(plan) {
    return Promise
      .try(() => {
        switch (plan.manager.name) {
        case CONST.INSTANCE_TYPE.DIRECTOR:
          return DirectorManager;
        case CONST.INSTANCE_TYPE.DOCKER:
          if (config.enable_swarm_manager) {
            return DockerManager;
          } else {
            assert.fail(plan.manager.name, [CONST.INSTANCE_TYPE.DIRECTOR, CONST.INSTANCE_TYPE.VIRTUAL_HOST], undefined, 'in');
          }
          break;
        case CONST.INSTANCE_TYPE.VIRTUAL_HOST:
          return VirtualHostManager;
        default:
          assert.fail(plan.manager.name, [CONST.INSTANCE_TYPE.DIRECTOR, CONST.INSTANCE_TYPE.DOCKER, CONST.INSTANCE_TYPE.VIRTUAL_HOST], undefined, 'in');
        }
      })
      .then(managerConstructor => managerConstructor.load(plan));
  }

  static createInstance(instance_id, service_id, plan_id, context) {
    const plan = catalog.getPlan(plan_id);
    assert.strictEqual(service_id, plan.service.id);
    return this
      .createManager(plan)
      .then(manager => {
        const instance = manager.createInstance(instance_id);
        return Promise
          .try(() => context ? context : instance.platformContext)
          .then(context => instance.assignPlatformManager(Fabrik.getPlatformManager(context.platform)))
          .return(instance);
      });
  }

  static getPlatformManager(platform) {
    const PlatformManager = (platform && CONST.PLATFORM_MANAGER[platform]) ? require(`./${CONST.PLATFORM_MANAGER[platform]}`) : ((platform && CONST.PLATFORM_MANAGER[CONST.PLATFORM_ALIAS_MAPPINGS[platform]]) ? require(`./${CONST.PLATFORM_MANAGER[CONST.PLATFORM_ALIAS_MAPPINGS[platform]]}`) : undefined);
    if (PlatformManager === undefined) {
      return new BasePlatformManager(platform);
    } else {
      return new PlatformManager(platform);
    }
  }

  static createOperation(name, opts) {
    return new ServiceFabrikOperation(name, opts);
  }
}
Fabrik.Agent = Agent;
Fabrik.VirtualHostAgent = VirtualHostAgent;
Fabrik.DockerManager = DockerManager;
Fabrik.DirectorManager = DirectorManager;
Fabrik.ServiceFabrikOperation = ServiceFabrikOperation;
Fabrik.dbManager = new DBManager();
Fabrik.oobBackupManager = OobBackupManager;
Fabrik.UnlockResourcePoller = require('./UnlockResourcePoller');
module.exports = Fabrik;