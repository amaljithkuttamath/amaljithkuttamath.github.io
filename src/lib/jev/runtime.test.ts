import {expect,it} from 'vitest';
import {classificationBase} from './runtime';
it('keeps local inference same-origin and requires explicit production HTTPS configuration',()=>{
 expect(classificationBase(true,undefined)).toBe('');
 expect(classificationBase(false,undefined)).toBeNull();
 expect(classificationBase(false,'https://jev.example/')).toBe('https://jev.example');
 for(const value of ['http://jev.example','https://secret@jev.example','https://jev.example/path','https://jev.example/?key=secret','javascript:alert(1)']) expect(classificationBase(false,value)).toBeNull();
});
