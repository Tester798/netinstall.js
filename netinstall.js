const readline = require('readline');
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');


const netinstall_only = false;
const listen_on_interface_address = '192.168.88.2';
const bootp_client_ip_address = '192.168.88.20';
const dir_npk = `${__dirname}/npk`;
const dir_key = `${__dirname}/key`;


const ip_to_ident = {};
const send_in_progress = {};
const netinstall_devices = {};
let showing_menu = false;
let host_ip;
let host_mac;
let s_bootp;
let s_tftp;
let s_netinstall;


function logtext(msg, r) {
    const t = new Date();
    let space = '';
    for (let i = t.getMilliseconds().toString().length; i < 3; i++)
        space += '0';
    const txt = t.toLocaleTimeString() + '.' + space + t.getMilliseconds() + ' ' + msg;
    if (r) {
        process.stdout.write(txt + '\r');
    } else {
        console.log(txt);
    }
}


function logtext_r(msg) {
    logtext(msg, true);
}


function logtext_percent(msg, percent) {
    if (percent < 100) {
        logtext_r(msg);
    } else {
        logtext(msg);
    }
}


function bytesFormatMac(buf, separator) {
    if (separator === undefined) separator = ':';
    let mac = '';
    for (let i = 0; i <= 5; i++) {
        mac += buf.toString('hex', i, i + 1);
        if (i < 5) mac += separator;
    }
    return mac;
}


function ipPortToHex(ip_port) {
    const ip_port_array = ip_port.split(':');
    const ip = ip_port_array[0];
    const port = ip_port_array[1] && Number(ip_port_array[1]).toString(16);
    const ip_array = ip.split('.');
    ip_array.forEach(function (el, index, array) {
        array[index] = Number(array[index]);
    });
    const buf = Buffer.alloc(port ? 6 : 4);
    buf.writeUInt8(ip_array[0], 0);
    buf.writeUInt8(ip_array[1], 1);
    buf.writeUInt8(ip_array[2], 2);
    buf.writeUInt8(ip_array[3], 3);
    if (port) buf.writeUInt16BE(port, 4);
    return buf.toString('hex');
}


function getNextNullStr(buf, pos_start) {
    const pos_end = buf.indexOf('00', pos_start, 'hex');
    const str = buf.toString('ascii', pos_start, pos_end);
    return [str, pos_end + 1];
}


function sendPacket(buffer, socket, port, address, callback) {
    socket.connect(port, address, err => {
        socket.send(buffer, err => {
            if (err) {
                console.error('Error in sendPacket while send:', err);
                return;
            }
            socket.disconnect();
            if (callback) callback();
        });
    });
}


function bootpReply(msg) {
    sendPacket(msg, s_bootp, 68, '255.255.255.255', () => {
        logtext(`Sent BOOTP "Boot Reply", offering IP ${bootp_client_ip_address}`);
    });
}


function sendTftpFile(to_ip, to_port, blk_size) {
    const key = to_ip + ':' + to_port;
    if (key in send_in_progress) return;
    send_in_progress[key] = true;
    logtext(`Sending file "vmlinux/${ip_to_ident[to_ip]}" to "${to_ip}:${to_port}" with blk_size "${blk_size}"`);

    const vmlinux = fs.readFileSync(`${__dirname}/vmlinux/${ip_to_ident[to_ip]}`);
    blk_size = Number(blk_size);
    blocks_total = Math.ceil(vmlinux.length / blk_size);

    const s = dgram.createSocket({
        type: 'udp4',
        reuseAddr: true,
    });

    s.connect(to_port, to_ip, () => {
        s.on('message', p => {
            if (p.toString('hex', 0, 2) === '0004') { // Opcode: Acknowledgement (4)
                const current_block = p.readUInt16BE(2);
                const percent = Math.floor(current_block / blocks_total * 100);
                const msg = `Got "Acknowledgement" for block ${current_block} / ${blocks_total}, ${percent}% done`;
                logtext_percent(msg, percent);
                if (current_block === blocks_total) {
                    s.disconnect();
                    return;
                }
                const next_block = Buffer.alloc(2);
                next_block.writeUInt16BE(current_block + 1);
                s.send(Buffer.concat([
                    Buffer.from('0003', 'hex'), // Opcode: Data Packet (3)
                    next_block, // Block
                    vmlinux.slice(current_block * blk_size, current_block * blk_size + blk_size), // Data
                ]));
            }
        });

        s.send(Buffer.from([
            '0006', // Opcode: Option Acknowledgement (6)
            Buffer.from('blksize').toString('hex'), // Option name: blksize
            '00',
            Buffer.from('' + blk_size).toString('hex'),
            '00',
        ].join(''), 'hex'));
    });

}


function parseNpkFile(filename) {
    const fd = fs.openSync(`${dir_npk}/${filename}`);
    const buf = Buffer.alloc(256);

    fs.readSync(fd, buf, 0, 256);
    fs.closeSync(fd);

    const name = buf.toString('ascii', 14, 30).replace(/\x00/g, '');
    const ver = buf.readUInt8(33) + '.' + buf.readUInt8(32) + (buf.toString('ascii', 31, 32) === 'b' ? 'beta' : '.') + buf.readUInt8(30);

    let pos;
    let len;

    pos = buf.indexOf('1800', 33, 'hex');
    pos += 2;
    len = buf.readUInt32LE(pos);
    pos += 4;
    const channel = buf.toString('ascii', pos, pos + len).trim();

    pos = buf.indexOf('1000', pos + len, 'hex');
    pos += 2;
    len = buf.readUInt32LE(pos);
    pos += 4;
    const arch = buf.toString('ascii', pos, pos + len).trim();

    pos = buf.indexOf('0200', pos + len, 'hex');
    pos += 2;
    len = buf.readUInt32LE(pos);
    pos += 4;
    const desc = buf.toString('ascii', pos, pos + len).trim();

    return {
        filename,
        name,
        ver,
        channel,
        arch,
        desc
    };
}


function saveKeyFileForDevice(device) {
    const filename = `${dir_key}/${device.mac}_${device.key_id}.key`
    const str = '-----BEGIN MIKROTIK SOFTWARE KEY------------\x0d\x0a' +
        device.key.substr(0, 44) + '\x0d\x0a' +
        device.key.substr(44) + '\x0d\x0a' +
        '-----END MIKROTIK SOFTWARE KEY--------------\x0d\x0a';
    fs.writeFileSync(filename, str);
    logtext(`Key was saved to "${filename}" file`);
}


function netInstallSendPacket(device, buffer, callback) {
    device.packet_counter_remote++;

    const pc_r = Buffer.alloc(2);
    pc_r.writeUInt16LE(device.packet_counter_remote);

    const pc_l = Buffer.alloc(2);
    pc_l.writeUInt16LE(device.packet_counter_local);

    const len = Buffer.alloc(2);
    len.writeUInt16LE(buffer.length);

    sendPacket(Buffer.from([
        host_mac, // mac of our host
        device.mac, // mac of device
        '0000', // spacer?
        len.toString('hex'),
        pc_r.toString('hex'),
        pc_l.toString('hex'),
        buffer.toString('hex'),
    ].join(''), 'hex'), s_netinstall, 5000, '255.255.255.255', callback)

    device.packet_counter_local++;
}


function netInstallSendNullPacket(device, callback) {
    netInstallSendPacket(device, Buffer.alloc(0), callback);
}


function netInstallStartSendNpkFile(device, npk) {
    if (device.send_progress) return;

    device.send_progress = {
        npk,
        buf: fs.readFileSync(`${dir_npk}/${npk.filename}`),
        pos: 0,
        started: false,
    };

    netInstallSendPacket(device, Buffer.from('OFFR\x0a\x0a'));
}


function keyPress(c) {
    if (showing_menu) return;
    switch (c) {
        case '\u0003':
            process.exit();
            break;
        case 'i':
        case 'I':
            if (Object.keys(netinstall_devices).length === 0) break;
            process.stdin.off('data', keyPress);
            showNetInstallMenu();
            break;
    }
}


function showNetInstallMenu() {
    showing_menu = true;

    let choice_num = 0;
    let choices = {};

    console.log('\n\n======================================================================');
    console.log(` ${choice_num}: Cancel`);
    choice_num++;

    console.log('\n Save key file for device:');
    for (let mac in netinstall_devices) {
        const device = netinstall_devices[mac];
        console.log(`    ${choice_num}: ${device.name} (${device.arch}) ${mac}`);

        choices[choice_num] = { func: saveKeyFileForDevice, params: [device] };
        choice_num++;
    }

    console.log('\n Send npk file to device:');
    for (let mac in netinstall_devices) {
        const device = netinstall_devices[mac];
        console.log(`     ${device.name} (${device.arch}) ${mac}:`);

        const npks = [];
        fs.readdirSync(dir_npk).forEach(file => {
            const npk = parseNpkFile(file);
            if (npk.arch !== device.arch) return;
            npks.push(npk);
        });

        if (npks.length === 0) {
            console.log(`         No npk files found for the device`);
            continue;
        }

        npks.forEach(npk => {
            console.log(`         ${choice_num}: ${npk.filename} | ${npk.arch} | ${npk.ver} | ${npk.channel} | ${npk.name}`);
            choices[choice_num] = { func: netInstallStartSendNpkFile, params: [device, npk] };
            choice_num++;
        });
    }
    console.log('======================================================================\n');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Enter choice number: ', ch => {
        console.log('');
        if (ch in choices) {
            choices[ch].func(...choices[ch].params);
        }

        showing_menu = false;
        rl.close();

        process.stdin.setRawMode(true);
        process.stdin.on('data', keyPress);
        process.stdin.resume();
    });
}


function parseNetInstallPacket(p) {
    const mac_from = bytesFormatMac(p.slice(0, 6), '');
    const mac_to = bytesFormatMac(p.slice(6, 12), '');
    const data_len = p.readUInt16LE(14);
    const packet_counter_remote = p.readUInt16LE(16);
    const packet_counter_local = p.readUInt16LE(18);
    const data = p.slice(20).toString('ascii').trim().split('\n');
    return {
        mac_from,
        mac_to,
        data_len,
        packet_counter_remote,
        packet_counter_local,
        data,
    };
}


function main() {
    logtext(`             IP address: ${host_ip}`);
    logtext(`BOOTP Client IP address: ${bootp_client_ip_address}\n`);


    if (!netinstall_only) {
        s_bootp = dgram.createSocket({
            type: 'udp4',
            reuseAddr: true,
        });

        s_tftp = dgram.createSocket({
            type: 'udp4',
            reuseAddr: true,
        });


        s_bootp.bind({
            port: 67,
            address: '0.0.0.0',
            exclusive: false,
        });

        s_tftp.bind({
            port: 69,
            address: host_ip,
            exclusive: false,
        });


        s_bootp.on('listening', () => {
            const addr = s_bootp.address();
            logtext(`Listening BOOTP      UDP on ${addr.address}:${addr.port}`);
        });

        s_tftp.on('listening', () => {
            const addr = s_tftp.address();
            logtext(`Listening TFTP       UDP on ${addr.address}:${addr.port}`);
        });


        s_bootp.on('message', p => {
            if (p.toString('hex', 0, 1) === '01') {
                const transaction_id = p.toString('hex', 4, 8);
                const seconds_elapsed = p.toString('hex', 8, 10);
                const mac = p.toString('hex', 28, 34);
                if (p.toString('hex', 236, 241) === '638253633c') { // Magic cookie: DHCP + Option: (60) Vendor class identifier
                    const len = p.readInt8(241); // length of Option: (60) Vendor class identifier
                    const vendor_ident = p.toString('ascii', 242, 242 + len);

                    logtext(`Got BOOTP "Boot Request" with "Transaction ID: ${transaction_id}" from client with MAC "${mac}", vendor id: "${vendor_ident}"`);

                    ip_to_ident[bootp_client_ip_address] = vendor_ident;

                    const reply = Buffer.from([
                        '02', // boot reply
                        '010600',
                        transaction_id,
                        seconds_elapsed,
                        '0000',
                        '00000000',
                        ipPortToHex(bootp_client_ip_address), // Your (client) IP address
                        ipPortToHex(host_ip), // Next server IP address
                        '00000000', // Relay agent IP address
                        mac, // Client MAC address
                        '00000000000000000000', // Client hardware address padding
                        '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000', // Server host name not given
                        '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000', // Boot file name not given
                        '63825363', // Magic cookie: DHCP
                        'ff', // Option: (255) End
                    ].join(''), 'hex');
                    bootpReply(reply);
                }
            }
        });

        s_tftp.on('message', (p, rinfo) => {
            if (p.toString('hex', 0, 2) === '0001') { // TFTP Read Request
                if (rinfo.address in ip_to_ident) {
                    let pos_end;
                    let filename;
                    [filename, pos_end] = getNextNullStr(p, 2);
                    let type;
                    [type, pos_end] = getNextNullStr(p, pos_end);
                    let option_name;
                    [option_name, pos_end] = getNextNullStr(p, pos_end);
                    if (option_name === 'blksize') {
                        let blk_size;
                        [blk_size, pos_end] = getNextNullStr(p, pos_end);
                        logtext(`Got TFTP "Read Request" from "${rinfo.address}:${rinfo.port}" for file "${filename}" type "${type}" blk_size "${blk_size}"`);
                        sendTftpFile(rinfo.address, rinfo.port, blk_size);
                    }
                }
            }
        });
    }


    s_netinstall = dgram.createSocket({
        type: 'udp4',
        reuseAddr: true,
    });

    s_netinstall.bind({
        port: 5000,
        address: '0.0.0.0',
        exclusive: false,
    });

    s_netinstall.on('listening', () => {
        const addr = s_netinstall.address();
        logtext(`Listening NetInstall UDP on ${addr.address}:${addr.port}\n`);
    });


    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', keyPress);


    s_netinstall.on('message', p => {
        if (showing_menu) return;

        const parsed = parseNetInstallPacket(p);

        if (parsed.data[0] === 'DSCV') {
            netinstall_devices[parsed.mac_from] = {
                packet_counter_remote: 0,
                packet_counter_local: 0,
                mac: parsed.mac_from,
            };

            const device = netinstall_devices[parsed.mac_from];

            device['key_id'] = parsed.data[1];
            device['key'] = parsed.data[2];
            device['name'] = parsed.data[3];
            device['arch'] = parsed.data[4];
            logtext_r(`Got NetInstall "Ready" from device "${device.name} (${device.arch})" with mac "${device.mac}". Press "i" for menu`);
            return;
        }

        if (parsed.mac_to !== host_mac) return; // packet is not for our host

        const device = netinstall_devices[parsed.mac_from];

        if (device === undefined) {
            logtext(`Received NetInstall packet from unknown device with mac "${parsed.mac_from}"`);
            return;
        }

        if (device.packet_counter_remote !== parsed.packet_counter_remote
            || device.packet_counter_local !== parsed.packet_counter_local
        ) {
            logtext(`Wrong NetInstall packet received from device with mac "${parsed.mac_from}":`);
            console.log(parsed);
            return;
        }

        if (parsed.data[0] !== 'RETR') logtext(`Got NetInstall "${parsed.data[0]}" from device "${device.name} (${device.arch})" with mac "${device.mac}"`);

        if (!device.send_progress) return;

        if (parsed.data[0] === 'YACK') {
            netInstallSendNullPacket(device);
            logtext('Waiting for the transfer to start...');
            return;
        }

        if (parsed.data[0] === 'STRT') {
            netInstallSendNullPacket(device);
            return;
        }

        if (parsed.data[0] === 'RETR') {
            if (!device.send_progress.started) {
                netInstallSendPacket(device, Buffer.from(
                    'FILE\x0a' +
                    device.send_progress.npk.filename + '\x0a' +
                    device.send_progress.buf.length + '\x0a'
                ), () => {
                    device.send_progress.started = true;
                });
            } else {
                const start = device.send_progress.pos;
                const end = start + 1452;
                netInstallSendPacket(device, device.send_progress.buf.slice(start, end), () => {
                    device.send_progress.pos = end;
                    const percent = Math.floor(end / device.send_progress.buf.length * 100);
                    const msg = `Sent chunk of "${device.send_progress.npk.filename}" to device with mac "${device.mac}", ${percent}% done`;
                    logtext_percent(msg, percent);
                });
            }
            return;
        }

        if (parsed.data[0] === 'WTRM') {
            logtext('Done, now wait for device to reboot and then you can start using it');
            return;
        }
    });
}


setTimeout(function checkNI() {
    const ni = os.networkInterfaces();
    const network_int = Object.keys(ni).map(interf => ni[interf].map(o => !o.internal && o.family === 'IPv4' && o.address === listen_on_interface_address && [o.address, o.mac])).reduce((a, b) => a.concat(b)).filter(el => el !== false);
    if (!network_int[0]) {
        logtext_r('Waiting for network interface...');
        setTimeout(checkNI, 1000);
        return;
    }
    host_ip = network_int[0][0];
    host_mac = network_int[0][1].replace(/:/g, '');
    main();
});