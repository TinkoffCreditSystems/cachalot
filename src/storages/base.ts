import { createHash } from 'crypto';
import isFunction from 'lodash/isFunction';
import partition from 'lodash/partition';
import uniq from 'lodash/uniq';
import { ConnectionStatus } from '../connection-status';
import deserialize from '../deserialize';
import createRecord from '../record';
import createTag from '../record/create-tag';
import serialize from '../serialize';
import { Storage, StorageRecord, StorageRecordTag, StorageRecordValue, WriteOptions } from '../storage';
import { StorageAdapter } from '../storage-adapter';

export const TAGS_VERSIONS_ALIAS = 'cache-tags-versions';

const NON_EXISTING_TAG_VERSION = 0;

export type BaseStorageOptions = {
  adapter: StorageAdapter;
  prefix?: string;
  hashKeys?: boolean;
  expiresIn?: number;
};

/**
 * Command is used as item of offline queue, which is used when adapter status becomes offline.
 * When adapter status becomes online, Storage flushes the queue and executes this commands.
 * Commands which was not executed successfully will be re-queued.
 */
export interface Command {
  fn: CommandFn;
  params: any;
}

/**
 * CommandFn is a function (usually a Storage method bind to its context) which is stored in
 * Command object for further execution.
 */
export type CommandFn = (...args: any[]) => any;

/**
 * BaseStorage is the default Storage implementation for Manager.
 *
 * It provides functionality of get, set, touching tags, locking keys etc.
 * It also manages command execution, supporting an "offline" queue of commands.
 */
export class BaseStorage implements Storage {
  constructor(options: BaseStorageOptions) {
    this.adapter = options.adapter;
    this.prefix = options.prefix || '';
    this.hashKeys = options.hashKeys || false;

    if (isFunction(this.adapter.setOptions)) {
      this.adapter.setOptions(options);
    }

    this.adapter.onConnect(async () => this.executeCommandsFromQueue());
  }

  /**
   * An offline commands queue.
   */
  private commandsQueue: Command[] = [];

  /**
   * The prefix is used to prevent conflicts in the key names of different BaseStorage instances.
   */
  private prefix: string;

  /**
   * Does it affect whether the keys are kept "as is" or they will be hashed. Hashing can be useful
   * for partitioning some databases.
   */
  private hashKeys: boolean;

  /**
   * The adapter is an interlayer between the underlying storage and the BaseStorage class.
   * Implements the StorageAdapter interface.
   */
  private adapter: StorageAdapter;

  /**
   * Gets a record using an adapter. It is expected that the adapter returns or null (value not found)
   * or serialized StorageRecord.
   */
  public async get(key: string): Promise<StorageRecord | null> {
    const record = deserialize(await this.adapter.get(this.createKey(key)));

    if (!this.isRecord(record)) {
      return null;
    }

    return record;
  }

  /**
   * Creates new set of tag records and updates them.
   */
  public async setTagVersions(tags: StorageRecordTag[]): Promise<any> {
    return Promise.all(tags.map(async (tag: StorageRecordTag) =>
      this.adapter.set(this.createTagKey(tag.name), `${tag.version}`)));
  }

  /**
   * Invalidates tags given as array of strings.
   */
  public async touch(tags: string[]): Promise<any> {
    return this.cachedCommand(this.setTagVersions.bind(this), tags.map(createTag));
  }

  /**
   * Causes the adapter to acquireLock and resolves to true if the adapter responds that the lock is successful.
   */
  public async lockKey(key: string): Promise<boolean> {
    return this.adapter.acquireLock(this.createKey(key));
  }

  /**
   * Releases the lock of key.
   */
  public async releaseKey(key: string): Promise<boolean> {
    return this.adapter.releaseLock(this.createKey(key));
  }

  /**
   * Checks if key is locked and returns true/false.
   */
  public async keyIsLocked(key: string): Promise<boolean> {
    return this.adapter.isLockExists(this.createKey(key));
  }

  /**
   * Deletes record by key.
   */
  public async del(key: string): Promise<any> {
    return this.cachedCommand(this.adapter.del.bind(this.adapter), this.createKey(key));
  }

  /**
   * Retrieves actual versions of tags from storage. Tags which was not found in storage will be created with 0
   * version.
   */
  public async getTags(tagNames: string[]): Promise<StorageRecordTag[]> {
    return Promise.all(tagNames.map(async tagName => ({
      name: tagName,
      version: Number(await this.adapter.get(this.createTagKey(tagName))) || NON_EXISTING_TAG_VERSION
    })));
  }

  /**
   * set creates new record with provided options and sets it to storage using the adapter.
   */
  public async set(key: string, value: StorageRecordValue, options: WriteOptions = {}): Promise<any> {
    let tags: string[] = [];
    if (isFunction(options.tags)) {
      tags = options.tags();
    } else if (options.tags !== undefined) {
      tags = options.tags;
    }
    const dynamicTags = isFunction(options.getTags) ? options.getTags(value) : [];

    if (!Array.isArray(dynamicTags)) {
      throw new TypeError(`getTags should return an array of strings, got ${typeof dynamicTags}`);
    }

    const allTagNames = uniq(tags.concat(dynamicTags));
    const allTags = await this.syncTags(allTagNames);

    const record = createRecord(key, value, allTags, options);

    await this.adapter.set(
      this.createKey(key),
      serialize({ ...record, value: serialize(record.value) }),
      record.expiresIn
    );

    return record;
  }

  /**
   * Returns current connection status of storage.
   */
  public getConnectionStatus(): ConnectionStatus {
    return this.adapter.getConnectionStatus();
  }

  /**
   * Checks if provided value is valid StorageRecord.
   */
  private isRecord(value: any): value is StorageRecord {
    return (value === null) || (typeof value === 'object' && value.key);
  }

  /**
   * Depending on the option, [hashKeys] generates an MD5 hash "key" for the storage or gives it "as is".
   * The key is generated from the "prefix" of the storage defined at the time of the creation of
   * the BaseStorage instance and identifier passed in the key parameter string.
   */
  private createKey(key: string): string {
    const rawKey = this.prefix ? `${this.prefix}-${key}` : key;

    return this.hashKeys ? createHash('md5').update(rawKey).digest('hex') : rawKey;
  }

  private createTagKey(tagName: string): string {
    return this.createKey(`${TAGS_VERSIONS_ALIAS}:${tagName}`);
  }

  /**
   * Executes commands from offline queue. Re-queues commands which was not successfully executed.
   */
  private async executeCommandsFromQueue(): Promise<any> {
    if (!this.commandsQueue.length) {
      return;
    }

    const unsuccessfullyExecutedCommands: Command[] = [];

    await Promise.all(this.commandsQueue.map(async ({ fn, params }) => {
      try {
        await fn(...params);
      } catch (executionError) {
        unsuccessfullyExecutedCommands.push({ fn, params });
      }
    }));

    this.commandsQueue = unsuccessfullyExecutedCommands;
  }

  /**
   * All commands wrapped with this method will be "cached". This means that if there are problems with the connection
   * the response will be sent immediately and the command will be executed later when the connection is restored.
   */
  private async cachedCommand(fn: CommandFn, ...args: any[]): Promise<any> {
    if (!fn) {
      throw new Error('Cached function is required');
    }

    const connectionStatus = this.adapter.getConnectionStatus();

    if (connectionStatus !== ConnectionStatus.CONNECTED) {
      return this.commandsQueue.push({
        fn,
        params: args
      });
    }

    return fn(...args);
  }

  /**
   * Synchronizes tags in tag storage.
   * If tag is missing creates it.
   * All existing tags will be preserved.
   *
   * Returns tags according to passed tag names.
   */
  private async syncTags(tagNames: string[]): Promise<StorageRecordTag[]> {
    const allTags = await this.getTags(tagNames);

    const [existingTags, nonExistingTags] = partition(allTags, tag => tag.version !== NON_EXISTING_TAG_VERSION);
    const createdTags = nonExistingTags.map(tag => createTag(tag.name));

    await this.setTagVersions(createdTags);

    return existingTags.concat(createdTags);
  }
}
