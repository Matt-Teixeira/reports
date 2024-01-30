const sort_by_manufacturer = (reportable_data) => {
  reportable_data.sort((a, b) => {
    // Assuming manufacturer is always a string and always present.
    // Convert to uppercase or lowercase for case-insensitive comparison.
    let manufacturerA = a.manufacturer.toLowerCase();
    let manufacturerB = b.manufacturer.toLowerCase();

    if (manufacturerA < manufacturerB) {
      return -1; // a comes first
    }
    if (manufacturerA > manufacturerB) {
      return 1; // b comes first
    }
    return 0; // a and b are equal
  });

  return reportable_data;
};

module.exports = sort_by_manufacturer;
