
const Tesseract = require('tesseract.js');
async function test() {
  const worker = await Tesseract.createWorker('eng');
  for (const psm of ['3', '4', '6', '11', '12']) {
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const res = await worker.recognize('scratch/bill_name_section.png');
    console.log('=== PSM ' + psm + ' ===');
    console.log(res.data.text.trim());
  }
  await worker.terminate();
}
test();
