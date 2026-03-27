"""Philogelos — Daily philosophical comedy via SMS"""
import json
import os
import random
from pathlib import Path

from twilio.rest import Client

TWILIO_SID = os.environ["TWILIO_SID"]
TWILIO_TOKEN = os.environ["TWILIO_TOKEN"]
TWILIO_FROM = os.environ["TWILIO_FROM"]
TO_PHONE = os.environ["TO_PHONE"]

SCRIPT_DIR = Path(__file__).parent
QUESTIONS_FILE = SCRIPT_DIR / "questions.json"
SENT_FILE = SCRIPT_DIR / "sent.json"


def load_questions():
    with open(QUESTIONS_FILE) as f:
        return json.load(f)


def load_sent():
    if SENT_FILE.exists():
        with open(SENT_FILE) as f:
            return json.load(f)
    return []


def save_sent(sent):
    with open(SENT_FILE, "w") as f:
        json.dump(sent, f, indent=2)


def pick_question():
    questions = load_questions()
    sent = load_sent()
    unsent = [q for q in questions if q not in sent]
    if not unsent:
        sent = []
        unsent = questions
    q = random.choice(unsent)
    sent.append(q)
    save_sent(sent)
    return q, len(sent)


def send_sms(text, day):
    client = Client(TWILIO_SID, TWILIO_TOKEN)
    msg = f"Day {day} — Philogelos asks:\n\n{text}"
    message = client.messages.create(body=msg, from_=TWILIO_FROM, to=TO_PHONE)
    print(f"Sent day {day}: {message.sid}")


if __name__ == "__main__":
    q, day = pick_question()
    send_sms(q, day)
