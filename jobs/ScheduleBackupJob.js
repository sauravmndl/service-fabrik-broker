'use strict';

const _ = require('lodash');
const Promise = require('bluebird');
const logger = require('../common/logger');
const config = require('../common/config');
const BaseJob = require('./BaseJob');
const CONST = require('../common/constants');
const errors = require('../common/errors');
const utils = require('../common/utils');
const retry = utils.retry;
const ServiceInstanceNotFound = errors.ServiceInstanceNotFound;
const catalog = require('../common/models').catalog;
const cloudController = require('../data-access-layer/cf').cloudController;
const backupStore = require('../data-access-layer/iaas').backupStore;
const ScheduleManager = require('./ScheduleManager');
//Above reference to schedulemanager leads to the below cyclic dependency:
// ScheduleManager -> Scheduler -> JobFabrik -> ScheduleBackupJob -> ScheduleManager
// However in JobFabrik the reference is done at runtime & hence the above reference back to ScheduleManager does
// not pose the typical issues of cyclic dependencies.

//Intentionally Jobs are kept as static as we register same definition for all Jobs of similar type
//Any instance specific references if reqiured for any jobs must be kept within run method for any future jobs
class ScheduleBackupJob extends BaseJob {

  static run(job, done) {
    return Promise.try(() => {
        job.__started_At = new Date();
        const jobData = job.attrs.data;
        logger.info(`-> Starting ScheduleBackupJob -  name: ${jobData[CONST.JOB_NAME_ATTRIB]} - with options: ${JSON.stringify(jobData)} `);
        if (!_.get(jobData, 'instance_id') || !_.get(jobData, 'type')) {
          const msg = `Scheduled backup cannot be initiated as the required mandatory params (intance_uid | type) is empty : ${JSON.stringify(jobData)}`;
          logger.error(msg);
          return this.runFailed(new errors.BadRequest(msg), undefined, job, done);
        }
        const backupRunStatus = {
          start_backup_status: 'failed',
          delete_backup_status: 'failed'
        };
        let instanceDeleted = false;
        return this
          .isServiceInstanceDeleted(jobData.instance_id)
          .tap(deleteStatus => instanceDeleted = deleteStatus)
          .then(() => {
            if (instanceDeleted) {
              return 'instance_deleted';
            }
            return this
              .getFabrikClient()
              .startBackup(_.pick(jobData, 'instance_id', 'type', 'trigger'))
              .catch(errors.Conflict, errors.UnprocessableEntity, (err) => {
                logger.error('Some other operation already in progress on this instance:', err);
                return this.reScheduleBackup(job)
                  .then(() => {
                    throw err;
                  });
              });
          })
          .tap(backupResponse => backupRunStatus.start_backup_status = backupResponse)
          .then(() => this.deleteOldBackup(job, instanceDeleted))
          .tap(deleteResponse => backupRunStatus.delete_backup_status = deleteResponse)
          .then(() => this.runSucceeded(backupRunStatus, job, done))
          .catch((error) => this.runFailed(error, backupRunStatus, job, done));
      })
      .catch(error => {
        logger.error(`Error occurred while handling failure for job :${job.attrs.data[CONST.JOB_NAME_ATTRIB]}`, error);
        done();
      });
  }

  static isServiceInstanceDeleted(instanceId) {
    return cloudController.findServicePlanByInstanceId(instanceId)
      .then(() => false)
      .catch(ServiceInstanceNotFound, () => {
        logger.warn(`service instance : ${instanceId} deleted`);
        return true;
      });
  }

  static deleteOldBackup(job, instanceDeleted) {
    const options = _.omit(job.attrs.data, 'trigger', 'type');
    return backupStore
      .listBackupsOlderThan(options, config.backup.retention_period_in_days)
      .then(oldBackups => this.filterOldBackups(oldBackups))
      .map(backup => {
        logger.debug(`Backup meta info : ${JSON.stringify(backup)}`);
        if (backup.trigger === CONST.BACKUP.TRIGGER.SCHEDULED || instanceDeleted) {
          //on-demand backups must be deleted after instance deletion.
          const logInfo = `backup guid : ${backup.backup_guid} - instance : ${options.instance_id} - type : ${backup.type} - backedup on : ${backup.started_at}`;
          logger.info(`-> Initiating delete of - ${logInfo} - instance deleted : ${instanceDeleted}`);
          const deleteOptions = {
            backup_guid: backup.backup_guid,
            tenant_id: options.tenant_id
          };
          return this
            .getFabrikClient()
            .deleteBackup(deleteOptions)
            .then(() => backup.backup_guid);
        }
      }).then(deletedBackupGuids => {
        logger.info(`Successfully deleted backup guids : ${deletedBackupGuids} - instance deleted : ${instanceDeleted}`);
        const deleteResponse = {
          deleted_guids: deletedBackupGuids,
          job_cancelled: false,
          instance_deleted: instanceDeleted
        };
        if (!instanceDeleted) {
          return deleteResponse;
        }
        logger.info(`Instance deleted. Checking if there are any more backups for :${options.instance_id}`);
        const backupStartedBefore = new Date().toISOString();
        return backupStore
          .listBackupFilenames(backupStartedBefore, options)
          .then(listOfFiles => {
            if (listOfFiles.length === 0) {
              //Instance is deleted and no more backups present. Cancel the backup scheduler for the instance
              logger.info(`-> No more backups for the deleted instance : ${options.instance_id}. Cancelling backup scheduled Job`);
              return ScheduleManager
                .cancelSchedule(options.instance_id, CONST.JOB.SCHEDULED_BACKUP)
                .then(() => {
                  deleteResponse.job_cancelled = true;
                  logger.info(`Job : ${job.attrs.data[CONST.JOB_NAME_ATTRIB]} is cancelled`);
                  return deleteResponse;
                })
                .catch(err => {
                  logger.error(`error occurred while cancelling schedule for : ${job.attrs.data[CONST.JOB_NAME_ATTRIB]}`, err);
                  return deleteResponse;
                });

            } else {
              logger.info(`Schedule Job for instance  ${options.instance_id} cannot be cancelled yet as ${listOfFiles.length} backup(s) exist`);
              return deleteResponse;
            }
          });
      });
  }

  static filterOldBackups(oldBackups) {
    let filteredOldBackups = [];
    /* oldBackups : This aray should contain all older backups
    // including last retenion day's backup. E.g. if retention period
    // is 15 days it would include all backups in (15th, 16th, 17th ...) */
    if (typeof oldBackups !== 'undefined' && oldBackups.length > 0) {
      // Older backups are sorted as latest at first
      let sortedBackups = _.sortBy(oldBackups, ['started_at']).reverse();
      const latestSuccessIndex = _.findIndex(sortedBackups,
        backup => backup.state === CONST.OPERATION.SUCCEEDED);
      if (latestSuccessIndex === -1) {
        //No successful backup beyond retention period.
        filteredOldBackups = sortedBackups;
      } else {
        //Should return backups before a successful backup.
        filteredOldBackups = _.slice(sortedBackups, latestSuccessIndex + 1);
      }
    }
    return filteredOldBackups;
  }
  static reScheduleBackup(job) {
    return Promise.try(() => {
      const jobData = _.cloneDeep(job.attrs.data);
      job.attrs.data.attempt = job.attrs.data.attempt + 1;
      const MAX_ATTEMPTS = _.get(job.attrs.data, 'max_attempts', config.scheduler.jobs.scheduled_backup.max_attempts);
      if (job.attrs.data.attempt > MAX_ATTEMPTS) {
        logger.error(`Scheduled backup for instance  ${jobData.instance_id} has exceeded max configured attempts : ${MAX_ATTEMPTS} - ${jobData.attempt}}. Initial attempt was done @: ${jobData.firstAttemptAt}.`);
        // Resetting the number of attempts to 0
        job.attrs.data.attempt = 0;
        return;
      }
      const RUN_AFTER = _.get(jobData, 'reschedule_delay', config.scheduler.jobs.reschedule_delay);
      let retryDelayInMinutes;
      logger.info(`Re-Schedulding Backup Job for ${jobData.instance_id} @ ${RUN_AFTER} - Attempt - ${job.attrs.data.attempt}. Initial attempt was done @: ${jobData.firstAttemptAt}`);
      if ((RUN_AFTER.toLowerCase()).indexOf('minutes') !== -1) {
        retryDelayInMinutes = parseInt(/^[0-9]+/.exec(RUN_AFTER)[0]);
      }
      const plan = catalog.getPlan(jobData.plan_id);
      let retryInterval = utils.getCronWithIntervalAndAfterXminute(plan.service.backup_interval || 'daily', retryDelayInMinutes);
      job.attrs.data.repeatInterval = retryInterval;
      return;
    });
  }
}

module.exports = ScheduleBackupJob;