import {elapsedTime} from '../execution-time';
test('elapsed includes human waiting and formats long durations without treating zero as missing',()=>{
 expect(elapsedTime(0,17)).toBe('17s'); expect(elapsedTime(0,.5)).toBe('<1s');
 expect(elapsedTime(1,62)).toBe('1m 1s'); expect(elapsedTime(0,7320)).toBe('2h 2m');
 expect(elapsedTime(undefined,10)).toBeUndefined(); expect(elapsedTime(10,1)).toBeUndefined(); expect(elapsedTime(NaN,10)).toBeUndefined();
});
