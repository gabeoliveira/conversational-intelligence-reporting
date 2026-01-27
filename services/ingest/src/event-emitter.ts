import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { PayloadReceivedEvent, EVENT_SOURCE, EVENT_DETAIL_TYPE_PAYLOAD_RECEIVED } from './types';

const eventBridgeClient = new EventBridgeClient({});
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

export async function emitEvent(payload: PayloadReceivedEvent): Promise<void> {
  await eventBridgeClient.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: EVENT_BUS_NAME,
          Source: EVENT_SOURCE,
          DetailType: EVENT_DETAIL_TYPE_PAYLOAD_RECEIVED,
          Detail: JSON.stringify(payload),
        },
      ],
    })
  );
}
