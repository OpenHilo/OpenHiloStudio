import {parseStudioBrand} from '../studio-brand';
test('brand is optional and does not mutate configuration',()=>{
 expect(parseStudioBrand()).toBeUndefined();const value={name:' Lab ',logoUrl:'/assets/logo.svg',title:' Lab desk '};
 expect(parseStudioBrand(value)).toEqual({name:'Lab',logoUrl:'/assets/logo.svg',title:'Lab desk'});expect(value.name).toBe(' Lab ');
});
test('brand rejects remote, executable, relative and ambiguous image URLs',()=>{
 for(const logoUrl of ['https://example.com/logo.svg','//example.com/logo','javascript:alert(1)','logo.svg','/\\example.com/x','/ logo']) expect(()=>parseStudioBrand({name:'Lab',logoUrl})).toThrow();
 expect(()=>parseStudioBrand({name:' '})).toThrow();
});
