'use strict';

const fs                 = require('fs');
const async              = require('async');
const { format }         = require('util');
const { execSync, exec } = require('child_process');

class Spinner {
    constructor() {
        this.admin_user = require('/AUTH').client_email;
        this.project_id = require('/AUTH').project_id;

        this.status = 'STARTING';
        this.stdout = '';
        this.stderr = '';
        this.error  = null;

        // fields to return
        this.proxyIP   = null;
        this.grafanaIP = null;
        this.cookieSecret = null;
        this.proxyKey     = null;
    }

    scheduleDeployment({ 
        cluster_name,
        namespace: namespace = 'course',
        cluster_size: cluster_size = 3,
        machine_type: machine_type = 'n1-standard-2',
        cpuLimit: cpuLimit = 1,
        cpuGuarantee: cpuGuarantee = 1,
        memoryLimit: memoryLimit = '1G',
        memoryGuarantee: memoryGuarantee = '1G',
        cullTime: cullTime = 3600,
        cullEnabled: cullEnabled = true,
        chart_version: chart_version = 'v0.5',
        imageName: imageName = 'jupyterhub/k8s-singleuser-sample',
        imageTag: imageTag = 'v0.5.0',
        installGrafana: installGrafana = true
    }, callback) {
        try {
            this.cookieSecret = execSync(`openssl rand -hex 32`).toString('utf8').trim();
            this.proxyKey = execSync(`openssl rand -hex 32`).toString('utf8').trim();

            let config = format(fs.readFileSync('./config-template.yaml').toString('utf8'), 
                    this.cookieSecret,
                    this.proxyKey,
                    imageName,
                    imageTag,
                    cpuLimit,
                    cpuGuarantee,
                    memoryLimit,
                    memoryGuarantee,
                    cullEnabled,
                    cullTime
                );
            fs.writeFileSync('./config.yaml', config);

        } catch(err) {
            if (err.stderr) {
                this.stderr = err.stderr.toString('utf8').trim();
            }
            callback(err);
        }


        let build_steps = [
            { code: `gcloud auth activate-service-account ${this.admin_user} --key-file /AUTH.json --project ${this.project_id}`, status: 'GOOGLE_AUTH' },
            { code: `gcloud container clusters create ${cluster_name} --num-nodes=${cluster_size} --machine-type=${machine_type} --zone=us-central1-b --cluster-version=1.8.4-gke.1`, status: 'CLUSTER_CREATING' }, // TODO - zone?
            { code: `kubectl create -f /grafana/grafana_install/  > /dev/null 2>&1`, status: 'INSTALL_GRAFANA', skip: !installGrafana, presleep: 10000 },
            { code: `echo $(kubectl get services --all-namespaces | grep grafana | awk '{print $5 }')`, status: 'FETCHING_GRAFANA_IP', skip: !installGrafana, wait_for_response: true, field: 'grafanaIP', presleep: 30000, regex: /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/ },
            { code: `curl -s -o /dev/null --connect-timeout 180 jupyter:T0mthumb@{GIP}/api/dashboards/db -d @/grafana/dashboard.json  --header "Content-Type: application/json"`, status: 'SETUP_GRAFANA', skip: !installGrafana, presleep: 30000 },
            { code: `kubectl create clusterrolebinding cluster-admin-binding --clusterrole=cluster-admin --user=${this.admin_user}`, status: 'CLUSTER_ROLE_BINDING' },
            { code: `kubectl --namespace kube-system create sa tiller`, status: 'HELM_INIT_1' },
            { code: `kubectl create clusterrolebinding tiller --clusterrole cluster-admin --serviceaccount=kube-system:tiller`, status: 'HELM_INIT_2' },
            { code: `helm init --service-account tiller`, status: 'HELM_INIT_3' },
            { code: `kubectl --namespace=kube-system patch deployment tiller-deploy --type=json --patch='[{"op": "add", "path": "/spec/template/spec/containers/0/command", "value": ["/tiller", "--listen=localhost:44134"]}]'`, status: 'HELM_SECURING'},
            { code: `helm repo add jupyterhub https://jupyterhub.github.io/helm-chart/`, status: 'HELM_REPO_UPD_1' },
            { code: `helm repo update`, status: 'HELM_REPO_UPD_2' },
            { code: `helm install jupyterhub/jupyterhub --version=${chart_version} --name=${namespace} --namespace=${namespace} -f config.yaml`, status: 'JUPYTERHUB_INSTALLATION', presleep: 15000 },
            { code: `echo $(kubectl get services --all-namespaces | grep proxy-public | awk '{print $5 }')`, status: 'FETCHING_HUB_IP', wait_for_response: true, field: 'proxyIP', presleep: 10000, regex: /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/ }
        ];

        async.eachSeries(build_steps, (step, cb) => {
            this.status = step.status;
            console.log(`Executing command: ${step.code}`);
            let timeOut = step.presleep || 5000;
            if (!step.skip) {
                setTimeout(()=> {
                    let count = 0, count_num = (step.wait_for_response) ? 1000 : 1;
                    async.whilst(
                        () => { return !((step.field && this[step.field] !== null) || count >= count_num); },
                        (cb1) => { 
                            count++;
                            if (count > 1) {
                                console.log(`Attempt #${count}`);
                            }
                            exec(step.code.replace('{GIP}',this.grafanaIP), { timeout: 600000, encoding: 'utf8' }, (err, stdout, stderr) => {
                                this.stdout += stdout;
                                this.stderr += stderr;
                                if (err) {
                                    console.log('ERROR: ', err);
                                    cb1(err);
                                }  else {
                                    if (step.regex && step.regex.test(stdout.trim())) {
                                        this[step.field] = stdout.trim();
                                    }
                                    cb1();
                                }
                            });
                        },
                        (err) => {
                            if (step.field && this[step.field] === null) {
                                cb( { message: 'Unable to get results' } );
                            } else {
                                cb(err);
                            }
                        }
                    );
                }, timeOut);
            } else {
                cb();
            }
        }, (err, result) => {
            if (!err) {
                console.log('Done');
                this.status = 'FINISHED';
            } else {
                console.log('Failed');
                this.error = err;
            }
            callback();
        });
    }

    getStatus() {
        let status = {};
        status.step = this.status;
        if (this.error) {
            status.state  = 'fail';
            status.error  = this.error;
            status.data   = {
                stdout: this.stdout,
                stderr: this.stderr
            }
        } else if (this.status === 'FINISHED') {
            status.state  = 'success';
            status.result = {
                cookieSecret: this.cookieSecret,
                proxyKey: this.proxyKey,
                proxyIP: this.proxyIP,
                grafanaIP: this.grafanaIP
            }
        } else {
            status.state  = 'running';
            status.data   = {
                stdout: this.stdout,
                stderr: this.stderr
            }
        }
        return status;
    }

}

module.exports = Spinner;
