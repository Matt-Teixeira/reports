const avante_link = (system_id, field_name) => {
  const link_str = "https://avanteconnected.com/system/";
  let complete_link = "";

  switch (field_name) {
    case "scan_seconds":
      complete_link = `${link_str}hhm/${system_id}`;
      break;
    case "system_scan_seconds":
      complete_link = `${link_str}hhm/${system_id}`;
      break;
    default:
      complete_link = `${link_str}${system_id}`;
      break;
  }

  return complete_link;
};

module.exports = avante_link;
