const net = require('net');
const Dispatch = require('./dispatch');
const Encryption = require('./encryption');
const { PacketIntegrity } = require('./integrity');

class Connection {
    constructor(metadata, clientInterfaceConnection, noIntegrity = false) {
        this.metadata = metadata || {};
        this.clientInterfaceConnection = clientInterfaceConnection;
        this.client = null;

        this.state = -1;
        this.session = new Encryption(this.metadata.protocolVersion, this.metadata.majorPatchVersion);

        const bufferType = this.metadata.platform === 'ps4' ? require('../packetBufferPS4') : require('../packetBuffer');
        this.buffer = new bufferType();

        this.builder = this.metadata.platform === 'ps4' ? require('../packetBuilderPS4') : require('../packetBuilder');

        this.dispatch = new Dispatch(this);

        this.integrity = null;

        if (!noIntegrity)
            if (this.metadata.majorPatchVersion >= 100)
                this.dispatch.hook(null, 'S_LOGIN_ACCOUNT_INFO', 3, { order: -Infinity, filter: { incoming: true } }, (event) => {
                    this.integrity = new PacketIntegrity(event.antiCheatChecksumSeed);
                });
            else if (this.metadata.majorPatchVersion >= 92)
                this.integrity = new PacketIntegrity(null);
    }

    connect(client, opt) {
        this.client = client;

        this.serverConnection = net.connect(opt);
        this.serverConnection.setNoDelay(true);

        this.serverConnection.on('connect', () => {
            this.state = -1;
            if (this.client)
                this.client.onConnect(this.serverConnection);
            else
                this.close();
        });

        this.serverConnection.on('data', (data) => {
            switch (this.state) {
                case -1: {
                    if (data.readUInt32LE(0) === 1) {
                        this.state = 0;
                        this.sendClient(data);
                    }
                    break;
                }

                case 0: {
                    if (data.length === 128) {
                        data.copy(this.session.serverKeys[0]);
                        this.state = 1;
                        this.sendClient(data);
                    }
                    break;
                }

                case 1: {
                    if (data.length === 128) {
                        data.copy(this.session.serverKeys[1]);
                        this.session.init();
                        this.state = 2;
                        this.sendClient(data);
                    }
                    break;
                }

                case 2: {
                    this.session.applyFromServer(data);
                    this.buffer.write(data);

                    // eslint-disable-next-line no-cond-assign
                    while (data = this.buffer.read()) {
                        if (this.dispatch)
                            data = this.dispatch.handle(data, true);

                        if (data)
                            this.sendClient(data);
                    }

                    break;
                }

                case 3:
                default: {
                    // closed
                    break;
                }
            }
        });

        this.serverConnection.on('close', () => {
            this.serverConnection = null;
            this.close();
        });

        return this.serverConnection;
    }

    setClientKey(key) {
        if (key.length !== 128) {
            throw new Error('key length != 128');
        }

        if (this.state !== 0 && this.state !== 1) {
            throw new Error('cannot set key in current state');
        }

        key.copy(this.session.clientKeys[this.state]);
        this.serverConnection.write(key);
    }

    sendClient(data) {
        if (this.client)
            this.client.onData(data);
    }

    sendServer(data) {
        if (this.serverConnection && !this.serverConnection.destroyed) {
            if (this.state === 2) {
                if (this.integrity) {
                    const code = data.readUInt16LE(2);

                    if (this.dispatch.protocolMap.padding[code])
                        this.integrity.apply(data, code);
                }

                data = this.builder(data);
                this.session.applyToServer(data);
            }

            this.serverConnection.write(data);
        }
    }

    close() {
        this.state = 3;

        if (this.serverConnection) {
            this.serverConnection.end();
            this.serverConnection.unref();
            this.serverConnection = null;
        }

        const { client } = this;
        if (client) {
            this.client = null; // prevent infinite recursion
            client.close();
        }

        if (this.dispatch) {
            this.dispatch.destructor();
            this.dispatch = null;
        }

        this.session = null;
        this.buffer = null;
        this.integrity = null;
    }
}

module.exports = Connection;
