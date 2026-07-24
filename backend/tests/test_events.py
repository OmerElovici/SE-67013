from backend.services.events import EventBroker


def test_broker_drops_oldest_event_for_slow_subscriber():
    broker = EventBroker(queue_size=2)
    queue = broker.subscribe()

    broker.publish({"sequence": 1})
    broker.publish({"sequence": 2})
    broker.publish({"sequence": 3})

    assert queue.get_nowait() == {"sequence": 2}
    assert queue.get_nowait() == {"sequence": 3}
