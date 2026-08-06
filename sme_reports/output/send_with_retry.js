// One retry with a short backoff for transient SMTP failures (throttling,
// connection resets). A second failure propagates to the caller's error
// handling/logging.
const RETRY_DELAY_MS = 5000;

const send_with_retry = async (transporter, message) => {
  try {
    return await transporter.sendMail(message);
  } catch (first_error) {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return transporter.sendMail(message);
  }
};

module.exports = send_with_retry;
