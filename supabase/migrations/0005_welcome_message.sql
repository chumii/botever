-- Willkommensnachricht wird konfigurierbar (statt einer Konstante im Code)
-- und ihre gepinnten Vorkommen werden getrackt, damit /willkommen
-- aktualisieren bestehende Pins per message.edit() aktualisieren kann statt
-- neue zu posten.

create table if not exists bot_settings (
  id boolean primary key default true check (id),
  welcome_message text not null default 'Hallo test'
);

insert into bot_settings (id) values (true) on conflict (id) do nothing;

create table if not exists welcome_messages (
  channel_id text primary key,
  message_id text not null
);
