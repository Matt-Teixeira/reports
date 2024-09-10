const convert = (degree_1, minute_1, second_1, degree_2, minute_2, second_2) => {
    let dd_1 = degree_1 + minute_1/60 + second_1/3600;
    let dd_2 = degree_2 + minute_2/60 + second_2/3600;
    console.log(`${dd_1.toFixed(6)}, -${dd_2.toFixed(6)}`);
}

convert(14, 53, 25, 80, 35, 58);