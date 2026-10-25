// Deterministic hook lifecycle harness: assertions concern network reads, cancellation,
// and stale-response isolation; browser acceptance additionally exercises React rendering.
let mockSlots: any[], mockCursor: number, mockDeps: any[] | undefined, mockCleanup: (() => void) | undefined;
jest.mock('react', () => ({
  useState: (initial: unknown) => { const i = mockCursor++; if (!(i in mockSlots)) mockSlots[i] = initial;
    return [mockSlots[i], (next: any) => { mockSlots[i] = typeof next === 'function' ? next(mockSlots[i]) : next; }]; },
  useEffect: (effect: () => any, deps: any[]) => { if (!mockDeps || deps.some((v, i) => !Object.is(v, mockDeps![i]))) {
    mockCleanup?.(); mockDeps = deps; mockCleanup = effect();
  } },
}));
import {useRunArtifact} from '../../hooks/useRunArtifact';
const decode = (value: unknown) => value;
const originalFetch = global.fetch;
function render(revision: string, url = '/node/n1/io') { mockCursor = 0; return (useRunArtifact as any)(url, decode, revision); }
async function settle() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
beforeEach(() => { mockSlots = []; mockDeps = undefined; mockCleanup = undefined; });
afterEach(() => { mockCleanup?.(); global.fetch = originalFetch; });
test('an open node inspector refreshes once when completion updates the same artifact URL', async () => {
  global.fetch = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify({outputs:null})))
    .mockResolvedValueOnce(new Response(JSON.stringify({outputs:{approved:false}})));
  render('running'); await settle();
  expect(render('running').data).toEqual({outputs:null});
  expect(render('completed').data).toBeUndefined(); await settle();
  expect(render('completed').data).toEqual({outputs:{approved:false}});
  render('completed'); expect(global.fetch).toHaveBeenCalledTimes(2);
});
test('a late pending read cannot replace newer completed data', async () => {
  let finishOld!: (value: Response) => void;
  global.fetch = jest.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockResolvedValueOnce(new Response(JSON.stringify({outputs:'finished'})));
  render('running'); render('completed'); await settle();
  finishOld(new Response(JSON.stringify({outputs:null}))); await settle();
  expect(render('completed').data).toEqual({outputs:'finished'});
});
