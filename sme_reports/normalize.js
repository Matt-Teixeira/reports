// Vendor row normalizers: raw DB rows -> the one canonical series shape
// everything downstream consumes:
//   { t, host_t, pressure, helium, compressor_on, coldhead_k, shield_k, ... }
// t/host_t are epoch ms; missing values are null. Pure functions with no DB
// or environment dependency, in their own module so the dev checks can push
// raw DB-shaped rows (e.g. a Philips malf of −1) through the REAL mapping
// without importing the pg pool.

const num = (v) => (v === null || v === undefined ? null : parseFloat(v));
const ms = (v) => (v ? new Date(v).getTime() : null);

const normalize_philips = (rows, vendor) =>
  rows.map((r) => {
    const malf = num(r.cryo_comp_malf_value);
    return {
      t: ms(r.capture_datetime),
      host_t: ms(r.host_datetime),
      pressure: num(r.monitor_magnet_pressure_value),
      pressure_avg: num(r.he_psi_avg_value),
      helium: num(r.helium_level_value),
      // Per the DDL: 0 = OK, >0 = alarm minutes, and −1 = CABLE ERROR — the
      // wire that reports compressor state is faulted or absent, so the
      // state is unknown, not "off". Mapping −1 to false manufactured
      // month-long "ongoing stops" on healthy systems whose only non-null
      // readings were cable errors (SME15805/09/11), while real stops read
      // as climbing positive alarm-minutes and are unaffected.
      compressor_on:
        malf === null || malf === -1
          ? null
          : malf === vendor.compressor.ok_value,
      coldhead_k: null,
      shield_k: null,
      temp_alarm: num(r.cryo_comp_temp_alarm_state) > 0,
      // Alarm-state value is minutes per the mag DDL (0=OK, >0=alarm minutes).
      temp_alarm_minutes: num(r.cryo_comp_temp_alarm_state),
      room_temp_c: num(r.tech_room_temp_value),
      quenched: num(r.quenched_state) === 1
    };
  });

const normalize_siemens_non_tim = (rows) =>
  rows.map((r) => ({
    t: ms(r.capture_datetime),
    host_t: ms(r.host_datetime),
    // Primary-metric slot: non-TIM has no pressure channel; shield
    // temperature is the warm-event signal (see vendors.SIEMENS_NON_TIM).
    pressure: num(r.shield_temp_value),
    pressure_avg: null,
    helium: num(r.he_level_1_value),
    compressor_on: null, // comes from the EDU vibration sensor, not mag data
    coldhead_k: null,
    shield_k: num(r.shield_temp_value),
    cab_temp: num(r.cca_cab_temp_value),
    cab_warn: num(r.cca_cab_temp_warn_value),
    cab_alarm: num(r.cca_cab_temp_alarm_value),
    temp_alarm: null,
    temp_alarm_minutes: null,
    room_temp_c: null,
    quenched: null
  }));

const normalize_siemens = (rows) =>
  rows.map((r) => {
    const status = r.compressor_status;
    return {
      t: ms(r.capture_datetime),
      host_t: ms(r.host_datetime),
      pressure: num(r.mag_psia_value),
      pressure_avg: null,
      helium: num(r.he_level_1_value) !== null
        ? num(r.he_level_1_value)
        : num(r.he_level_2_value),
      // compressor_status is text: 'ON' when running; any other non-null
      // literal is treated as not running; null carries no information.
      compressor_on: status == null ? null : String(status).toUpperCase() === "ON",
      coldhead_k: num(r.cold_head_sensor_1_value),
      shield_k: null,
      temp_alarm: null,
      temp_alarm_minutes: null,
      room_temp_c: null,
      quenched: null
    };
  });

const normalize_ge = (rows, vendor) =>
  rows.map((r) => {
    const coldhead = num(r.coldhead_ruo_value);
    return {
      t: ms(r.capture_datetime),
      host_t: ms(r.host_datetime),
      pressure: num(r.he_pressure_value),
      pressure_avg: null,
      helium: num(r.he_level_value),
      compressor_on:
        coldhead === null
          ? null
          : coldhead < vendor.compressor.cold_threshold_k,
      coldhead_k: coldhead,
      shield_k: num(r.shield_si410_value),
      temp_alarm: null,
      temp_alarm_minutes: null,
      room_temp_c: null,
      quenched: null
    };
  });

module.exports = {
  num,
  ms,
  normalize_philips,
  normalize_ge,
  normalize_siemens,
  normalize_siemens_non_tim
};
