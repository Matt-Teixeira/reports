const build_transporter = require("./build-transporter");
const send_email = require("./send_email");

async function send_it(run_log, job_id, email_address, full_email_text) {
  try {
    const transporter = await build_transporter();

    await send_email(
      run_log,
      job_id,
      transporter,
      email_address,
      full_email_text
    );
  } catch (error) {
    console.log(error);
  }
}

module.exports = send_it;
