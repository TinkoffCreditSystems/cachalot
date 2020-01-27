import TestStorageAdapter from '../adapters/test';
import { ConnectionStatus } from '../connection-status';
import timeout from '../timeout';
import { BaseStorage, TAGS_VERSIONS_ALIAS } from './base';

const testInterface = {
  internalStorage: {}
};
let testAdapter;
let storage;

describe('BaseStorage', () => {
  beforeEach(() => {
    testAdapter = new TestStorageAdapter(testInterface, true);
    testInterface.internalStorage = {};
    storage = new BaseStorage({
      adapter: testAdapter,
      prefix: 'cache',
      hashKeys: false,
      expiresIn: 10000
    });
  });

  it('set creates record without value and tags if value === undefined', async () => {
    await storage.set('test', undefined, { tags: ['tag'] });

    const value = JSON.parse(testInterface.internalStorage['cache-test']);

    expect(value).toMatchObject({
      key: 'test',
      permanent: true
    });
    expect(value.tags).toHaveLength(0);
  });

  it('default prefix is empty string', async () => {
    storage = new BaseStorage({
      adapter: testAdapter,
      hashKeys: false,
      expiresIn: 10000
    });

    await storage.set('test', '123');

    expect((testInterface.internalStorage as any).test).toEqual(expect.any(String));
  });

  it('creates hashed by md5 keys if hashKeys set to true', async () => {
    storage = new BaseStorage({
      adapter: testAdapter,
      hashKeys: true,
      expiresIn: 10000
    });

    await storage.set('test', '123');

    expect((testInterface.internalStorage as any)).toMatchObject({
      '098f6bcd4621d373cade4e832627b4f6': expect.any(String)
    });
  });

  it('setOptions sets options to adapter', () => {
    const options = {
      adapter: testAdapter,
      prefix: 'cache',
      hashKeys: false,
      expiresIn: 10000
    };

    testAdapter.setOptions = jest.fn();
    storage = new BaseStorage(options);
    expect(testAdapter.setOptions).toBeCalledWith(options);
  });

  it('set sets key to storage adapter', async () => {
    await storage.set('test', '123');

    const value = JSON.parse(testInterface.internalStorage['cache-test']);

    expect(value).toMatchObject({
      key: 'test',
      permanent: true,
      value: '"123"'
    });
    expect(value.tags).toEqual([]);
    expect(value.expiresIn).toEqual(expect.any(Number));
  });

  it('set sets key to storage adapter with dynamic tags', async () => {
    await storage.set('test', '123', { getTags: (result) => [result]});

    const value = JSON.parse(testInterface.internalStorage['cache-test']);

    expect(value).toMatchObject({
      key: 'test',
      permanent: true,
      value: '"123"'
    });
    expect(value.tags).toMatchObject([{ name: '123'}]);
    expect(value.expiresIn).toEqual(expect.any(Number));
    expect(testInterface.internalStorage[`cache-${TAGS_VERSIONS_ALIAS}:123`]).toEqual(expect.any(String));
  });

  it('set sets key to storage adapter with uniq array of concatenated dynamic tags and simple tags', async () => {
    await storage.set('test', '123', { tags: ['tag1', '123'], getTags: (result) => [result]});

    const value = JSON.parse(testInterface.internalStorage['cache-test']);

    expect(value).toMatchObject({
      key: 'test',
      permanent: true,
      value: '"123"'
    });
    expect(value.tags).toMatchObject([{ name: 'tag1'}, { name: '123'}]);
    expect(value.expiresIn).toEqual(expect.any(Number));

    expect(testInterface.internalStorage[`cache-${TAGS_VERSIONS_ALIAS}:tag1`]).toEqual(expect.any(String));
    expect(testInterface.internalStorage[`cache-${TAGS_VERSIONS_ALIAS}:123`]).toEqual(expect.any(String));
  });

  it('set creates non-existing tag and preserves existing ones', async () => {
    const existingTag = { name: 'tag1', version: 1537176259922 };
    testInterface.internalStorage[`cache-${TAGS_VERSIONS_ALIAS}:${existingTag.name}`] = existingTag.version;
    const newTag = 'newTag';

    await storage.set('test', '123', { tags: [existingTag.name, newTag] });

    const value = JSON.parse(testInterface.internalStorage['cache-test']);

    expect(value).toMatchObject({
      key: 'test',
      permanent: true,
      value: '"123"'
    });
    expect(value.tags).toMatchObject([{ name: existingTag.name}, { name: newTag}]);

    expect(testInterface.internalStorage[`cache-${TAGS_VERSIONS_ALIAS}:${existingTag.name}`]).toEqual(existingTag.version);
    expect(testInterface.internalStorage[`cache-${TAGS_VERSIONS_ALIAS}:${newTag}`]).toEqual(expect.any(String));
  });

  it('set throws if dynamic tags Fn returns non-array value', async () => {
    await expect(storage.set('test', '123', { getTags: (result) => result})).rejects.toThrow();
  });

  it('set sets object key to storage adapter with dynamic tags', async () => {
    await storage.set('test', { id: 'uuid' }, { getTags: ({ id }) => [id]});

    const value = JSON.parse(testInterface.internalStorage['cache-test']);

    expect(value).toMatchObject({
      key: 'test',
      permanent: true,
      value: '{"id":"uuid"}'
    });
    expect(value.tags).toMatchObject([{ name: 'uuid'}]);
    expect(value.expiresIn).toEqual(expect.any(Number));
  });

  it('set sets key to storage adapter with given options', async () => {
    await storage.set('test', '123', { expiresIn: 0 });

    const value = JSON.parse(testInterface.internalStorage['cache-test']);

    expect(value).toMatchObject({
      key: 'test',
      permanent: true,
      value: '"123"'
    });
    expect(value.tags).toEqual([]);
    expect(value.expiresIn).toEqual(expect.any(Number));
  });

  it('get returns value from adapter', async () => {
    await storage.set('test', '123', { expiresIn: 0 });
    expect(await storage.get('test'))
      .toEqual({
        createdAt: expect.any(Number),
        expiresIn: 0,
        key: 'test',
        permanent: true,
        tags: [],
        value: '\"123\"'
      });
  });

  it('touch updates cache tags', async () => {
    await storage.set('test', '123', { expiresIn: 0, tags: ['sometag'] });

    const TIMEOUT = 10;
    const tagsBefore = testInterface.internalStorage['cache-cache-tags-versions:sometag'];

    await timeout(TIMEOUT);
    await storage.touch(['sometag']);

    expect(testInterface.internalStorage['cache-cache-tags-versions:sometag']).not.toEqual(tagsBefore);
  });

  it('getLockedKeyRetrieveStrategy throws if cannot get strategy', () => {
    expect(() => storage.getLockedKeyRetrieveStrategy('unknown')).toThrow();
  });

  it('get returns result if value exists in storage', async () => {
    await storage.set('test', '123', { expiresIn: 100 });

    expect(await storage.get('test', () => { /* empty */ })).toMatchObject({ value: '"123"' });
  });

  it('get returns null if value not exists in storage', async () => {
    expect(await storage.get('test')).toBeNull();
  });

  it('get throws if storage returns invalid record', async () => {
    (testInterface.internalStorage as any).test = {};

    expect(await storage.get('test')).toBeNull();
  });

  it('del deletes key from storage', async () => {
    await storage.set('test', '123', { expiresIn: 500 });
    await storage.set('test1', '1234', { expiresIn: 500 });
    await storage.set('test2', '1234', { expiresIn: 500 });

    expect(await storage.get('test')).toMatchObject({ value: '\"123\"' });
    await storage.del('test');
    await expect(storage.get('test')).resolves.toBeNull();
  });

  it('getTags returns actual tag versions', async () => {
    const tag1 = { name: 'tag1', version: 1537176259547 };
    const tag2 = { name: 'tag2', version: 1537176259572 };
    const tag3 = { name: 'tag3', version: 1537176259922 };

    testInterface.internalStorage[`cache-${TAGS_VERSIONS_ALIAS}:${tag1.name}`] = tag1.version;
    testInterface.internalStorage[`cache-${TAGS_VERSIONS_ALIAS}:${tag2.name}`] = tag2.version;
    testInterface.internalStorage[`cache-${TAGS_VERSIONS_ALIAS}:${tag3.name}`] = tag3.version;

    expect(await (storage as any).getTags(['tag2', 'tag3'])).toEqual([tag2, tag3]);
    expect(await (storage as any).getTags(['tag1', 'tag3'])).toEqual([tag1, tag3]);
    expect(await (storage as any).getTags(['tag3', 'tag2'])).toEqual([tag3, tag2]);
  });

  it('getTags creates tag with zero version if it not exists', async () => {
    const tag1 = { name: 'tag1', version: 1537176259547 };

    testInterface.internalStorage[`cache-${TAGS_VERSIONS_ALIAS}:${tag1.name}`] = tag1.version;

    expect(await (storage as any).getTags(['tag1', 'tag3'])).toEqual([tag1, {
      name: 'tag3',
      version: 0
    }]);
  });

  it('lockKey returns true if lock exists', async () => {
    await storage.set('test', '123', { expiresIn: 0 });

    expect(await (storage as any).lockKey('test')).toEqual(true);
    expect(testInterface.internalStorage['cache-test_lock']).toEqual('');
  });

  it('lockKey returns false if lock exists', async () => {
    await storage.set('test', '123', { expiresIn: 0 });

    testAdapter.acquireLock = (): boolean => false;

    expect(await (storage as any).lockKey('test')).toEqual(false);
    expect(testInterface.internalStorage['cache-test_lock']).toEqual(undefined);
  });

  it('releaseLock releases lock', async () => {
    (testInterface.internalStorage as any)['cache-test_lock'] = '{\"key\":\"cache-test_lock\"}';

    expect(await storage.get('test_lock', () => { /* empty */ })).toMatchObject({ key: 'cache-test_lock' });
    await storage.releaseKey('test');
    expect(await storage.get('test_lock', () => { /* empty */ })).toBeNull();
  });

  it('keyIsLocked returns true if lock exists', async () => {
    (testInterface.internalStorage as any)['cache-test_lock'] = '{\"key\":\"cache-test_lock\"}';
    expect(await storage.keyIsLocked('test')).toEqual(true);
  });

  it('cachedCommand throws if function is undefined', async () => {
    await expect((storage as any).cachedCommand(undefined, 1, 'hello')).rejects.toThrow();
  });

  it('getConnectionStatus returns current connection status', () => {
    expect(storage.getConnectionStatus()).toEqual(ConnectionStatus.CONNECTED);
  });

  it('cachedCommand pushes command to command queue if status is not CONNECTED', async () => {
    const command = jest.fn();
    testAdapter.getConnectionStatus = (): ConnectionStatus => ConnectionStatus.DISCONNECTED;

    await expect((storage as any).cachedCommand(command, 1, 'hello')).resolves.toEqual(1);
    expect(storage.commandsQueue).toEqual([{ fn: command, params: [1, 'hello' ]}]);
  });

  it('executeCommandsFromQueue does nothing if queue is empty', async () => {
    await expect((storage as any).executeCommandsFromQueue()).resolves.not.toThrow();
  });

  it('executeCommandsFromQueue executes commands and saves unsuccessfull commands to queue', async() => {
    const command1 = async (a: number): Promise<number> => a;
    const command2 = async (a: number, b: number): Promise<void> => {
      throw new Error('error!');
    };
    const command3 = async (a: number, b: number): Promise<number> => a + b;
    (storage as any).commandsQueue = [
      {
        fn: command1,
        params: [1]
      },
      {
        fn: command2,
        params: [1, 1]
      },
      {
        fn: command3,
        params: [1, 1]
      }
    ];
    await expect((storage as any).executeCommandsFromQueue()).resolves.not.toThrow();
    expect((storage as any).commandsQueue).toEqual([
      {
        fn: command2,
        params: [1, 1]
      }
    ]);
  });

  it('set creates record with static tags calculated by function', async () => {
    await storage.set('test', 'test', { tags: () => ['tag'] });

    const value = JSON.parse(testInterface.internalStorage['cache-test']);

    expect(value).toMatchObject({
      key: 'test',
      permanent: true,
      value: '"test"'
    });

    expect(value.tags).toMatchObject([{ name: 'tag' }]);
    expect(value.expiresIn).toEqual(expect.any(Number));
  });
});
