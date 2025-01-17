// Copyright 2018 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

const {assert} = require('chai');
const {describe, it, before, after, afterEach} = require('mocha');
const uuid = require('uuid');
const {PubSub} = require('@google-cloud/pubsub');
const cp = require('child_process');
const DLP = require('@google-cloud/dlp');
const proxyquire = require('proxyquire');
const sinon = require('sinon');

const {MOCK_DATA} = require('./mockdata');

const execSync = cmd => {
  return cp.execSync(cmd, {
    encoding: 'utf-8',
    stdio: [null, null, null],
  });
};

const dataset = 'integration_tests_dlp';
const uniqueField = 'Name';
const numericField = 'Age';
const pubsub = new PubSub();
const client = new DLP.DlpServiceClient();

// Dummy resource names used in test cases mocking API Calls.
const datasetId = 'MOCK_DATASET_ID';
const sourceTableId = 'MOCK_SOURCE_TABLE';
const outputTableId = 'MOCK_OUTPUT_TABLE';

/*
 * The tests in this file rely on a table in BigQuery entitled
 * "integration_tests_dlp.harmful" with the following fields:
 *
 * Age NUMERIC NULLABLE
 * Name STRING NULLABLE
 *
 * Insert into this table a few rows of Age/Name pairs.
 */
describe('risk', () => {
  let projectId;
  // Create new custom topic/subscription
  let topic, subscription, topicName, subscriptionName, jobName;

  before(async () => {
    topicName = `dlp-risk-topic-${uuid.v4()}-${Date.now()}`;
    subscriptionName = `dlp-risk-subscription-${uuid.v4()}-${Date.now()}`;
    projectId = await client.getProjectId();
    [topic] = await pubsub.createTopic(topicName);
    [subscription] = await topic.createSubscription(subscriptionName);
    await deleteOldTopics();
  });

  async function deleteOldTopics() {
    const [topics] = await pubsub.getTopics();
    const now = Date.now();
    const TEN_HOURS_MS = 1000 * 60 * 60 * 10;
    for (const topic of topics) {
      const created = Number(topic.name.split('-').pop());
      if (
        topic.name.includes('dlp-risk-topic') &&
        now - created > TEN_HOURS_MS
      ) {
        const [subscriptions] = await topic.getSubscriptions();
        for (const subscription of subscriptions) {
          console.info(`deleting ${subscription.name}`);
          await subscription.delete();
        }
        console.info(`deleting ${topic.name}`);
        await topic.delete();
      }
    }
  }

  // Delete custom topic/subscription
  after(async () => {
    await subscription.delete();
    await topic.delete();
  });

  // Delete risk analysis job created in the snippets.
  afterEach(async () => {
    sinon.restore();
    const request = {
      name: jobName,
    };

    client
      .deleteDlpJob(request)
      .then(() => {
        console.log(`Successfully deleted job ${jobName}.`);
      })
      .catch(err => {
        throw `Error in deleteJob: ${err.message || err}`;
      });
  });

  // numericalRiskAnalysis
  it('should perform numerical risk analysis', () => {
    const output = execSync(
      `node numericalRiskAnalysis.js ${projectId} ${projectId} ${dataset} harmful ${numericField} ${topicName} ${subscriptionName}`
    );
    assert.match(output, /Value at 0% quantile:/);
    assert.match(output, /Value at \d+% quantile:/);
    assert.match(output, /Job created. Job name: /);
    jobName = output.split(':')[1].trim();
  });

  it('should handle numerical risk analysis errors', () => {
    let output;
    try {
      output = execSync(
        `node numericalRiskAnalysis.js ${projectId} ${projectId} ${dataset} nonexistent ${numericField} ${topicName} ${subscriptionName}`
      );
    } catch (err) {
      output = err.message;
    }
    assert.include(output, 'NOT_FOUND');
  });

  // categoricalRiskAnalysis
  it('should perform categorical risk analysis on a string field', () => {
    const output = execSync(
      `node categoricalRiskAnalysis.js ${projectId} ${projectId} ${dataset} harmful ${uniqueField} ${topicName} ${subscriptionName}`
    );
    assert.match(output, /Most common value occurs \d time\(s\)/);
    assert.match(output, /Job created. Job name: /);
    jobName = output.split(':')[1].trim();
  });

  it('should perform categorical risk analysis on a number field', () => {
    const output = execSync(
      `node categoricalRiskAnalysis.js ${projectId} ${projectId} ${dataset} harmful ${numericField} ${topicName} ${subscriptionName}`
    );
    assert.match(output, /Most common value occurs \d time\(s\)/);
    assert.match(output, /Job created. Job name: /);
    jobName = output.split(':')[1].trim();
  });

  it('should handle categorical risk analysis errors', () => {
    let output;
    try {
      output = execSync(
        `node categoricalRiskAnalysis.js ${projectId} ${projectId} ${dataset} nonexistent ${uniqueField} ${topicName} ${subscriptionName}`
      );
    } catch (err) {
      output = err.message;
    }
    assert.include(output, 'fail');
  });

  // kAnonymityAnalysis
  it('should perform k-anonymity analysis on a single field', () => {
    const output = execSync(
      `node kAnonymityAnalysis.js ${projectId} ${projectId} ${dataset} harmful ${topicName} ${subscriptionName} ${numericField}`
    );
    console.log(output);
    assert.include(output, 'Quasi-ID values:');
    assert.include(output, 'Class size:');
    assert.match(output, /Job created. Job name: /);
    jobName = output.split(':')[1].trim();
  });

  it('should handle k-anonymity analysis errors', () => {
    let output;
    try {
      output = execSync(
        `node kAnonymityAnalysis.js ${projectId} ${projectId} ${dataset} nonexistent ${topicName} ${subscriptionName} ${numericField}`
      );
    } catch (err) {
      output = err.message;
    }
    assert.include(output, 'fail');
  });

  // kMapAnalysis
  it('should perform k-map analysis on a single field', () => {
    const output = execSync(
      `node kMapEstimationAnalysis.js ${projectId} ${projectId} ${dataset} harmful ${topicName} ${subscriptionName} 'US' ${numericField} AGE`
    );
    assert.match(output, /Anonymity range: \[\d+, \d+\]/);
    assert.match(output, /Size: \d/);
    assert.match(output, /Values: \d{2}/);
    assert.match(output, /Job created. Job name: /);
    jobName = output.split(':')[1].trim();
  });

  it('should handle k-map analysis errors', () => {
    let output;
    try {
      output = execSync(
        `node kMapEstimationAnalysis.js ${projectId} ${projectId} ${dataset} nonexistent ${topicName} ${subscriptionName} ${numericField} AGE`
      );
    } catch (err) {
      output = err.message;
    }
    assert.include(output, 'fail');
  });

  it('should check that numbers of quasi-ids and info types are equal', () => {
    assert.throws(() => {
      execSync(
        `node kMapEstimationAnalysis.js ${projectId} ${projectId} ${dataset} harmful ${topicName} ${subscriptionName} 'US' 'Age,Gender' AGE`
      );
    }, /3 INVALID_ARGUMENT: InfoType name cannot be empty of a TaggedField/);
  });

  // lDiversityAnalysis
  it('should perform l-diversity analysis on a single field', () => {
    const output = execSync(
      `node lDiversityAnalysis.js ${projectId} ${projectId} ${dataset} harmful ${topicName} ${subscriptionName} ${uniqueField} ${numericField}`
    );
    assert.match(output, /Quasi-ID values:/);
    assert.match(output, /Class size: \d/);
    assert.match(output, /Sensitive value/);
    assert.match(output, /Job created. Job name: /);
    jobName = output.split(':')[1].trim();
  });

  it('should handle l-diversity analysis errors', () => {
    let output;
    try {
      output = execSync(
        `node lDiversityAnalysis.js ${projectId} ${projectId} ${dataset} nonexistent ${topicName} ${subscriptionName} ${numericField}`
      );
    } catch (err) {
      output = err.message;
    }
    assert.include(output, 'fail');
  });

  // dlp_k_anonymity_with_entity_id
  it('should perform k-map analysis using entity ID', async () => {
    const jobName = 'test-job-name';
    const DATA_CONSTANTS = MOCK_DATA.K_ANONYMITY_WITH_ENTITY_ID(
      projectId,
      datasetId,
      sourceTableId,
      outputTableId,
      jobName
    );
    const mockCreateDlpJob = sinon.stub().resolves([{name: jobName}]);
    sinon.replace(
      DLP.DlpServiceClient.prototype,
      'createDlpJob',
      mockCreateDlpJob
    );

    const mockGetDlpJob = sinon.fake.resolves(
      DATA_CONSTANTS.RESPONSE_GET_DLP_JOB_SUCCESS
    );
    sinon.replace(DLP.DlpServiceClient.prototype, 'getDlpJob', mockGetDlpJob);
    const mockConsoleLog = sinon.stub();
    sinon.replace(console, 'log', mockConsoleLog);

    const kAnonymityWithEntityIds = proxyquire('../kAnonymityWithEntityIds', {
      '@google-cloud/dlp': {DLP: DLP},
    });
    await kAnonymityWithEntityIds(
      projectId,
      datasetId,
      sourceTableId,
      outputTableId
    );
    sinon.assert.calledOnceWithExactly(
      mockCreateDlpJob,
      DATA_CONSTANTS.REQUEST_CREATE_DLP_JOB
    );
    sinon.assert.calledOnce(mockGetDlpJob);
  });

  it('should handle error if risk job fails', async () => {
    const jobName = 'test-job-name';
    const DATA_CONSTANTS = MOCK_DATA.K_ANONYMITY_WITH_ENTITY_ID(
      projectId,
      datasetId,
      sourceTableId,
      outputTableId,
      jobName
    );
    const mockCreateDlpJob = sinon.stub().resolves([{name: jobName}]);
    sinon.replace(
      DLP.DlpServiceClient.prototype,
      'createDlpJob',
      mockCreateDlpJob
    );

    const mockGetDlpJob = sinon.fake.resolves(
      DATA_CONSTANTS.RESPONSE_GET_DLP_JOB_FAILED
    );
    sinon.replace(DLP.DlpServiceClient.prototype, 'getDlpJob', mockGetDlpJob);
    const mockConsoleLog = sinon.stub();
    sinon.replace(console, 'log', mockConsoleLog);

    const kAnonymityWithEntityIds = proxyquire('../kAnonymityWithEntityIds', {
      '@google-cloud/dlp': {DLP: DLP},
    });
    await kAnonymityWithEntityIds(
      projectId,
      datasetId,
      sourceTableId,
      outputTableId
    );
    sinon.assert.calledOnce(mockGetDlpJob);
    sinon.assert.calledWithMatch(
      mockConsoleLog,
      'Job Failed, Please check the configuration.'
    );
  });
});
