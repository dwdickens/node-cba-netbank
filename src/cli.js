#!/usr/bin/env node

/* eslint-disable no-use-before-define */

// Dependencies
const netbank = require('./api');

const chalk = require('chalk');
const debug = require('debug')('node-cba-netbank');
const fs = require('fs');
const inquirer = require('inquirer');
const moment = require('moment-timezone');
const Table = require('easy-table');
const yargs = require('yargs');

moment.tz.setDefault('Australia/Sydney');

const msgQuit = 'quit';
const tagQuit = chalk.red('<Quit>');
const tagAccountName = '<name>';
const tagAccountNumber = '<number>';
const tagFrom = '<from>';
const tagTo = '<to>';
const outputFilenameTemplate = `[${tagAccountName}](${tagAccountNumber}) [${tagFrom} to ${tagTo}].json`;
const sortableDateFormat = 'YYYY-MM-DD';
const argumentDateFormat = 'DD/MM/YYYY';

class Render {
  static currency(amount) {
    return amount >= 0 ? chalk.green.bold(`$${amount}`) : chalk.red.bold(`$${amount}`);
  }
  static account(account) {
    return (
      `${chalk.bold(account.name)} \t(${chalk.red(account.bsb)} ${chalk.red(account.account)})` +
      `\t Balance: ${Render.currency(account.balance)} ` +
      `\t Available Funds: ${Render.currency(account.available)}`
    );
  }
  static accounts(accounts) {
    return Table.print(
      accounts.map(account => ({
        Name: chalk.bold(account.name),
        Number: `${chalk.red(account.bsb)} ${chalk.red(account.account)}`,
        Balance: `${Render.currency(account.balance)}`,
        Available: `${Render.currency(account.available)}`,
      })),
    );
  }
  static transactions(transactions) {
    return Table.print(
      transactions.map(t => ({
        Time: chalk.italic.cyan(moment(t.timestamp).format('YYYY-MM-DD HH:mm')),
        Description: t.pending ? chalk.gray(t.description) : chalk.white(t.description),
        Amount: Render.currency(t.amount),
        Balance: t.pending ? '' : Render.currency(t.balance),
      })),
    );
  }
}

/* eslint-disable class-methods-use-this */
class UI {
  constructor() {
    this.accounts = [];
  }

  start(argv) {
    return new Promise((resolve) => {
      //  check given credential
      const questions = [];

      //  client number
      if (!argv.username) {
        questions.push({
          type: 'input',
          name: 'username',
          message: 'Client number:',
          validate: input => /^\d{1,8}$/.test(input),
        });
      }

      //  password
      if (!argv.password) {
        questions.push({
          type: 'password',
          name: 'password',
          message: 'Password:',
          validate: input => /^[\w\d-]{4,16}$/.test(input),
        });
      }

      return resolve(questions.length > 0 ? inquirer.prompt(questions) : argv);
    })
      .then(c => this.logon(c))
      .then(() => this.chooseAccountAndShowHistory(argv.months))
      .catch((error) => {
        debug(error);
        console.log('Bye!');
      });
  }

  logon(credential) {
    console.log(`Logon as account ${credential.username} ...`);
    return netbank
      .logon(credential)
      .catch(() =>
        inquirer
          .prompt({
            type: 'confirm',
            name: 'tryagain',
            message: 'Failed to logged in, try again?',
          })
          .then((answer) => {
            if (answer.tryagain) {
              console.log();
              return this.start(credential);
            }
            throw new Error(msgQuit);
          }),
      )
      .then((resp) => {
        this.accounts = resp.accounts;
        return this.accounts;
      });
  }

  chooseAccountAndShowHistory(months) {
    return this.selectAccount()
      .then(account => this.downloadHistoryAndShow(account, moment().subtract(months, 'months').format(argumentDateFormat)))
      .then(() => this.chooseAccountAndShowHistory(months));
  }

  selectAccount() {
    return inquirer
      .prompt({
        type: 'list',
        name: 'account',
        message: 'Which account?',
        choices: this.accounts.map(a => ({ name: Render.account(a), value: a })).concat([tagQuit]),
      })
      .then((answer) => {
        if (answer.account === tagQuit) {
          throw new Error(msgQuit);
        }
        const account = this.accounts.find(v => answer.account.number === v.number);
        if (!account) {
          throw new Error(msgQuit);
        }
        debug(`selectAccount(${Render.account(answer.account)}): found account ${Render.account(account)}`);
        return account;
      });
  }

  downloadHistory(account, from, to) {
    console.log(`Downloading history [${from} => ${to}] ...`);
    return netbank.getTransactionHistory(account, from, to);
  }

  downloadHistoryAndShow(account, from, to = moment().format(argumentDateFormat)) {
    return this.downloadHistory(account, from, to).then((history) => {
      const allTransactions = history.pendings
        .map(t => Object.assign({}, t, { pending: true }))
        .concat(history.transactions);
      console.log(Render.transactions(allTransactions));
      console.log(
        `Total ${history.transactions.length} transactions and ${history.pendings.length} pending transactions.`,
      );
      return history;
    });
  }
}

const ui = new UI();
const myArgv = yargs
  .usage('CBA Netbank CLI\nUsage: $0 <command> [args]')
  .option('u', {
    alias: 'username',
    demandOption: !process.env.NETBANK_USERNAME,
    default: process.env.NETBANK_USERNAME,
    defaultDescription: '$NETBANK_USERNAME',
    describe: 'client number',
    type: 'string',
  })
  .option('p', {
    alias: 'password',
    demandOption: !process.env.NETBANK_PASSWORD,
    default: process.env.NETBANK_PASSWORD,
    defaultDescription: '$NETBANK_PASSWORD',
    describe: 'password',
    type: 'string',
  })
  .command(
    'list',
    'List accounts',
    () => {},
    (argv) => {
      debug(`Listing accounts ${JSON.stringify(argv)}...`);
      ui.logon(argv).then((accounts) => {
        console.log(Render.accounts(accounts));
      });
    },
  )
  .command(
    'download',
    'Download transactions history for given account',
  {
    a: {
      alias: 'account',
      demandOption: true,
      describe: 'account name or number',
      type: 'string',
    },
    f: {
      alias: 'from',
      default: moment().subtract(3, 'months').format(argumentDateFormat),
      describe: 'history range from date',
      type: 'string',
    },
    t: {
      alias: 'to',
      default: moment().format(argumentDateFormat),
      describe: 'history range to date',
      type: 'string',
    },
    o: {
      alias: 'output',
      default: outputFilenameTemplate,
      describe: 'output file name',
      type: 'string',
    },
    format: {
      default: 'json',
      describe: 'the output file format',
      type: 'string',
      choices: ['json'],
    },
  },
    (argv) => {
      debug(`Download transactions ${JSON.stringify(argv)}...`);
      ui.logon(argv).then((accounts) => {
        //  matching accounts
        const account = accounts.find(
          a => a.name.toLowerCase().indexOf(argv.account.toLowerCase()) >= 0 || a.number.indexOf(argv.account) >= 0,
        );
        if (account) {
          debug(`${Render.account(account)}`);
          ui.downloadHistory(account, argv.from, argv.to).then((history) => {
            console.log(`Retrieved ${history.transactions.length} transactions`);
            const filename = argv.output
              .replace(tagAccountName, account.name)
              .replace(tagAccountNumber, account.number)
              .replace(tagFrom, moment(argv.from, argumentDateFormat).format(sortableDateFormat))
              .replace(tagTo, moment(argv.to, argumentDateFormat).format(sortableDateFormat));
            console.log(`filename: ${filename}`);
            fs.writeFile(filename, JSON.stringify(history.transactions), (error) => {
              if (error) {
                throw error;
              }
            });
          });
        } else {
          console.log(`Cannot find account matching pattern '${argv.account}'`);
        }
      });
    },
  )
  .command(
    'ui',
    'Interactive user interface.',
  {
    m: {
      alias: 'months',
      default: 2,
      describe: 'how many months of history should be shown',
      type: 'number',
    },
  },
    (argv) => {
      debug(`UI: ${JSON.stringify(argv)}...`);
      ui.start(argv).catch(debug);
    },
  )
  .demandCommand(1, 'You have to tell me what to do, right?')
  .help().argv;

debug(`argv => ${JSON.stringify(myArgv)}`);