const express       = require('express');
const bodyParser    = require('body-parser');
const app           = express();

const Spinner       = require('./spinner');


const port          = 3000;
const auth          = require('/auth_token').token;

let spinner         = null;

// Init middliware

app.use(bodyParser.json());
app.use((req, res, next) => {
    let auth_header = req.header('Auth');
    if (auth_header === auth) {
        next();
    } else {
        res.status(401).send();
    }
});

app.post('/deploy', (req, res) => {
    if (!spinner) {
        spinner = new Spinner();
        if (!req.body.cluster_name) {
            spinner = null;
            res.status(400).send({ message: 'cluster_name is required' });
        } else {
            spinner.scheduleDeployment(req.body, ()=>{});
            res.status(200).send();
        }
    } else {
        res.status(409).send({ message: 'Another build is running' });
    }
});

app.get('/status', (req, res) => {
    if (spinner) {
        let status = spinner.getStatus();
        res.status(200).send({ status: status });
    } else {
        res.status(200).send({ code: 'READY' });
    }
});

app.listen(port, (err) => {
  if (err) {
    return console.error(err);
  }
  console.log(`Spinner is listening on ${port}`);
});
