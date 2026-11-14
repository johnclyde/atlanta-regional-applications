const assert = require('node:assert/strict');
const { placeMatches } = require('../site/static/core.js');
const places = [
  {id:'13193', geo:'County', label:'Macon', name:'Macon County', region:false},
  {id:'1349008', geo:'City', label:'Macon-Bibb', name:'Macon-Bibb County', region:false},
  {id:'13121', geo:'County', label:'Fulton', name:'Fulton County', region:true},
  {id:'13089100100', geo:'Tract', label:'Tract 1001', name:'Census Tract 1001', region:true},
];
assert.deepEqual(placeMatches(places, ' macon ').map(p=>p.id), ['1349008','13193']);
assert.deepEqual(placeMatches(places, 'MACON BIBB').map(p=>p.geo), ['City']);
assert.deepEqual(placeMatches(places, 'Macon County').map(p=>p.id), ['13193']);
assert.equal(placeMatches(places, 'fulton')[0].region, true);
assert.equal(placeMatches(places, '1349008')[0].name, 'Macon-Bibb County');
assert.equal(placeMatches(places, 'tract 1001')[0].geo, 'Tract');
assert.equal(placeMatches([...places, places[1]], 'macon').length, 2);
assert.equal(placeMatches(places, 'missing-place').length, 0);
assert.equal(placeMatches(places, '   ').length, 0);
assert.equal(placeMatches(places, '<script>').length, 0);
assert.equal(placeMatches([{id:'x', geo:'City', name:'Café', label:'Café'}], 'cafe')[0].id, 'x');
assert.deepEqual(placeMatches([...places, {id:'1312128',name:'Butler city',label:'Butler',geo:'City'}], '13121').map(p=>p.id), ['13121']);
console.log('12 place-search checks passed: city/county ambiguity, exact names and IDs, scope independence, words/case/spacing, districts, deduplication and no results.');
