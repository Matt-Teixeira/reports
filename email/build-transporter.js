const nodemailer = require('nodemailer');

const build_transporter = async () => {
    try {
       const transporter = nodemailer.createTransport({
          // TODO: RESEARCH OPTIONS
          // secure: true,
          // port: '587',
          // tls: {
          //    ciphers: 'SSLv3',
          //    rejectUnauthorized: true,
          // },
          host: 'smtp.office365.com',
          auth: {
             user: process.env.OUTLOOK_USER,
             pass: process.env.OUTLOOK_PW,
          },
          // debug: true,
          // logger: true,
       });
 
       return transporter;
    } catch (error) {
       throw new Error(`build_transporter FN CATCH -> ${error.message}`, {
          cause: error,
       });
    }
 };
 
 module.exports = build_transporter;