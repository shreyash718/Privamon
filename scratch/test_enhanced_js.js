// Test script to verify enhanced Privamon.PIIDetector in Node
const fs = require('fs');

// Mock window/global Privamon
global.Privamon = {};
const detectorCode = fs.readFileSync('privacy/pii-detector.js', 'utf8');
eval(detectorCode);

const detector = Privamon.PIIDetector;

console.log('=== TEST 1: Aadhaar Verhoeff Checksum ===');
console.log('validateVerhoeff("234567890124"):', detector.validateVerhoeff('234567890124'));
console.log('aadhaarCheck("2345 6789 0124"):', detector.aadhaarCheck('2345 6789 0124'));
console.log('aadhaarCheck("2345 6789 0129"):', detector.aadhaarCheck('2345 6789 0129'));

console.log('\n=== TEST 2: Email Sentence Bleeding ===');
const emailText = 'Contact rahul.sharma@example.com. Please write soon.';
const emailDets = detector.detectInText(emailText, 'dom');
console.log('Email detections:', emailDets.map(d => ({ type: d.type, text: d.text })));

console.log('\n=== TEST 3: Negative Prefix Suppression (Order ID vs Phone) ===');
const orderText = 'Your Order ID #9876543210 has been shipped.';
const orderDets = detector.detectInText(orderText, 'dom');
console.log('Order ID detections (should be empty):', orderDets.map(d => ({ type: d.type, text: d.text })));

console.log('\n=== TEST 4: Real Phone Number (Should be detected) ===');
const phoneText = 'Please call my mobile +91 9876543210 for delivery.';
const phoneDets = detector.detectInText(phoneText, 'dom');
console.log('Phone detections:', phoneDets.map(d => ({ type: d.type, text: d.text })));

console.log('\n=== TEST 5: Negative Prefix Suppression (PIN code vs OTP) ===');
const pinText = 'Delivery PIN Code: 560001 Bangalore';
const pinDets = detector.detectInText(pinText, 'dom');
console.log('PIN code detections (should be empty):', pinDets.map(d => ({ type: d.type, text: d.text })));

console.log('\n=== TEST 6: UPI ID, DL & Voter ID ===');
const idsText = 'Pay to anita.kumar@okhdfcbank or check DL MH-12-2018-0001234 or Voter ID ABC1234567';
const idsDets = detector.detectInText(idsText, 'dom');
console.log('ID detections:', idsDets.map(d => ({ type: d.type, text: d.text })));
