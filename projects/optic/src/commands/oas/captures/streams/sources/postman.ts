import { Readable } from 'stream';
import { Result, Ok } from 'ts-results';
import invariant from 'ts-invariant';
import {
  Collection,
  Item,
  ItemGroup,
  Request,
  Response,
  VariableScope,
} from 'postman-collection';

export type PostmanEntry = {
  request: Request;
  response?: Response;
  variableScope: VariableScope;
};

export interface PostmanCollectionEntries extends AsyncIterable<PostmanEntry> {}
export interface TryPostmanCollection
  extends AsyncIterable<Result<PostmanEntry, Error>> {}

export class PostmanCollectionEntries {
  // Note: The postman-collection SDK doesn't support async
  // data loading. The implementation of this function essentially
  // turns fromReadable into a synchronous iterable, but we maintain
  // the async interface.
  static async *fromReadable(source: Readable): TryPostmanCollection {
    invariant(
      !source.readableObjectMode,
      'Expecting raw bytes to parse Postman Collection entries'
    );

    // Read to end as UTF-8 string
    let collectionSource = '';
    source.setEncoding('utf-8');
    for await (const chunk of source) {
      collectionSource += chunk;
    }

    // Ensure input can be parsed as JSON.
    let collectionDefinition: Collection.definition | null = null;
    try {
      collectionDefinition = JSON.parse(collectionSource);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(
          `Source could not be read as Postman Collection: ${err.message}`
        );
      } else {
        throw err;
      }
    }

    // Only continue if this collection is non-empty.
    if (!collectionDefinition?.item) {
      return;
    }

    const collection: Collection & ItemGroup = new Collection(
      collectionDefinition
    );
    const variableScope = new VariableScope(collection.variables);

    // Recursively iterate through folders.
    const items: Item[] = [];
    collection.forEachItem((item) => items.push(item));

    for (const item of items) {
      yield Ok({
        request: item.request,
        variableScope,
      });

      for (const response of item.responses.all()) {
        yield Ok({
          request: response.originalRequest || item.request,
          response,
          variableScope,
        });
      }
    }
  }
}
