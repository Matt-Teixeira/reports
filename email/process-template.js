const Handlebars = require("handlebars");

const process_template = async (template, data) => {

  try {
    const compiled_temp = Handlebars.compile(template);
    const processed_text = compiled_temp(data);
    return processed_text;
  } catch (error) {
    console.log(error);
  }
};

module.exports = process_template;
