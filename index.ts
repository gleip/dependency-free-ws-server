import * as http from 'http';
import * as stream from 'stream';
import { createHash } from 'crypto';

export class SocketServer {
  private HANDSHAKE_CONSTANT = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  private MASK_LENGTH = 4; // Длина маски. Указана в спецификации
  private OPCODE = {
    PING: 0x89, // Первый байт управляющего байта Ping
    SHORT_TEXT_MESSAGE: 0x81, // Первый байт фрейма с данными которые убираются в 125 байт
  };
  private DATA_LENGTH = {
    MIDDLE: 128, // Нужно что бы исключить первый бит из байта с длинной сообщения
    SHORT: 125, // Максимальная длина короткого сообщения
    LONG: 126, // Означает что следующие 2 байта содержат длину сообщения
    VERY_LONG: 127, // Означает что следующие 8 байт содержат длину сообщения
  };
  private CONTROL_MESSAGES = {
    PING: Buffer.from([this.OPCODE.PING, 0x0]),
  };
  private connections: Set<stream.Duplex> = new Set();
  constructor(private port: number, heartbeatTimeout: number) {
    http
      .createServer()
      .on('upgrade', (request: http.IncomingMessage, socket: stream.Duplex) => {
        const clientKey = request.headers['sec-websocket-key'];
        const handshakeKey = createHash('sha1')
          .update(clientKey + this.HANDSHAKE_CONSTANT)
          .digest('base64');
        const responseHeaders = [
          'HTTP/1.1 101',
          'upgrade: websocket',
          'connection: upgrade',
          `sec-websocket-accept: ${handshakeKey}`,
          '\r\n',
        ];

        socket.on('data', (data: Buffer) => {
          if (data[0] === this.OPCODE.SHORT_TEXT_MESSAGE) {
            const meta = this.decryptMessage(data);
            const message = this.unmasked(meta.mask, meta.data);
            this.connections.forEach(socket => {
              this.sendShortMessage(message, socket);
            });
          }
        });

        socket.write(responseHeaders.join('\r\n'));

        const id = setInterval(() => socket.write(this.CONTROL_MESSAGES.PING), heartbeatTimeout);
        const events = ['end', 'close', 'error'] as const;

        events.forEach((event) => {
          socket.once(event, () => {
            console.log(`Socket terminated due to connection ${event}`);

            clearInterval(id);
            this.connections.delete(socket);
          })
        });

        this.connections.add(socket);

        this.connections.forEach(socket => {
          this.sendShortMessage(
            Buffer.from(`Подключился новый участник чата. Всего в чате ${this.connections.size}`),
            socket,
          );
        });
      })
      .listen(this.port);
    console.log('server start on port: ', this.port);
  }

  private decryptMessage(message: Buffer) {
    const length = message[1] ^ this.DATA_LENGTH.MIDDLE; // 1
    if (length <= this.DATA_LENGTH.SHORT) {
      return {
        length,
        mask: message.slice(2, 6), // 2
        data: message.slice(6),
      };
    }
    if (length === this.DATA_LENGTH.LONG) {
      return {
        length: message.slice(2, 4).readInt16BE(), // 3
        mask: message.slice(4, 8),
        data: message.slice(8),
      };
    }
    if (length === this.DATA_LENGTH.VERY_LONG) {
      return {
        payloadLength: message.slice(2, 10).readBigInt64BE(), // 4
        mask: message.slice(10, 14),
        data: message.slice(14),
      };
    }
    throw new Error('Wrong message format');
  }

  private unmasked(mask: Buffer, data: Buffer) {
    return Buffer.from(data.map((byte, i) => byte ^ mask[i % this.MASK_LENGTH]));
  }

  public sendShortMessage(message: Buffer, socket: stream.Duplex) {
    const meta = Buffer.alloc(2);
    meta[0] = this.OPCODE.SHORT_TEXT_MESSAGE;
    meta[1] = message.length;
    socket.write(Buffer.concat([meta, message]));
  }
}

new SocketServer(8080, 5000);
