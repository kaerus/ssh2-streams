var crypto = require('crypto');

var Ber = require('asn1').Ber;

var SSH_TO_OPENSSL = require('./constants').SSH_TO_OPENSSL;

var RE_STREAM = /^arcfour/i,
    RE_GCM = /^aes\d+-gcm/i,
    RE_KEY_LEN = /(.{64})/g;

module.exports = {
  iv_inc: function(iv) {
    var n = 12, c = 0;
    do {
      --n;
      c = iv[n];
      if (c === 255)
        iv[n] = 0;
      else {
        iv[n] = ++c;
        return;
      }
    } while (n > 4);
  },
  isStreamCipher: function(name) {
    return RE_STREAM.test(name);
  },
  isGCM: function(name) {
    return RE_GCM.test(name);
  },
  readInt: function(buffer, start, stream, cb) {
    if ((buffer.length - start) < 4) {
    console.dir(buffer.slice(start));
      stream && stream._cleanup(cb);
      return false;
    }

    return buffer.readUInt32BE(start, true);
  },
  readString: function(buffer, start, encoding, stream, cb) {
    if (encoding && !Buffer.isBuffer(encoding) && typeof encoding !== 'string') {
      cb = stream;
      stream = encoding;
      encoding = undefined;
    }

    var left = buffer.length - start,
        len,
        end;
    if (left < 4) {
      stream && stream._cleanup(cb);
      return false;
    }

    len = buffer.readUInt32BE(start, true);
    if (left < (4 + len)) {
      stream && stream._cleanup(cb);
      return false;
    }

    start += 4;
    end = start + len;
    buffer._pos = end;

    if (encoding) {
      if (Buffer.isBuffer(encoding)) {
        buffer.copy(encoding, 0, start, end);
        return encoding;
      } else
        return buffer.toString(encoding, start, end);
    } else
      return buffer.slice(start, end);
  },
  parseKey: require('./keyParser'),
  decryptKey: function(keyInfo, passphrase) {
    var iv = new Buffer(keyInfo.extra[0], 'hex'),
        keylen = 0,
        key,
        dc,
        out,
        orig,
        newOrig,
        b64key;

    keyInfo.encryption = (SSH_TO_OPENSSL[keyInfo.encryption]
                          || keyInfo.encryption);

    switch (keyInfo.encryption) {
      case 'aes-256-cbc':
      case 'aes-256-ctr':
        keylen = 32; // eg. 256 / 8
        break;
      case 'des-ede3-cbc':
      case 'des-ede3':
      case 'aes-192-cbc':
      case 'aes-192-ctr':
        keylen = 24; // eg. 192 / 8
        break;
      case 'aes-128-cbc':
      case 'aes-128-ctr':
      case 'cast-cbc':
      case 'bf-cbc':
        keylen = 16; // eg. 128 / 8
        break;
    }
    key = new Buffer(crypto.createHash('md5')
                           .update(passphrase
                                   + iv.toString('binary', 0, 8),
                                   'binary')
                           .digest('binary'), 'binary');

    while (keylen > key.length) {
      key = Buffer.concat([
        key,
        new Buffer(crypto.createHash('md5')
                         .update(key.toString('binary')
                                 + passphrase
                                 + iv.toString('binary'),
                                 'binary')
                         .digest('binary'), 'binary').slice(0, 8)
      ]);
    }
    if (key.length > keylen)
      key = key.slice(0, keylen);

    dc = crypto.createDecipheriv(keyInfo.encryption, key, iv);
    dc.setAutoPadding(false);
    out = dc.update(keyInfo.private, 'binary', 'binary');
    out += dc.final('binary');

    // update our original base64-encoded version of the private key
    orig = keyInfo.privateOrig.toString('utf8');
    newOrig = /^(.+(?:\r\n|\n))/.exec(orig)[1];
    b64key = new Buffer(out, 'binary').toString('base64');
    newOrig += b64key.match(/.{1,70}/g).join('\n');
    newOrig += /((?:\r\n|\n).+)$/.exec(orig)[1];

    keyInfo.private = new Buffer(out, 'binary');
    keyInfo.privateOrig = newOrig;
  },
  genPublicKey: function(keyInfo) {
    var publicKey,
        p,
        nStart, nLen, eStart, eLen, // RSA
        pStart, pLen, qStart, qLen, gStart, gLen, yStart, yLen; // DSA

    if (keyInfo.private) {
      // parsing private key in ASN.1 format in order to generate a public key
      var privKey = keyInfo.private,
          i = 2,
          len,
          octets;

      if (privKey[0] === 0x30) {
        if (privKey[1] & 0x80)
          i += (privKey[1] & 0x7F);

        // version -- integer
        if (privKey[i++] !== 0x02)
          throw new Error('Malformed private key (expected integer for version)');
        len = privKey[i++];
        if (len & 0x80) {
          octets = len & 0x7F;
          len = 0;
          while (octets > 0) {
            len += (privKey[i++] * Math.pow(2, (octets - 1) * 8));
            --octets;
          }
        }
        i += len; // skip version value

        if (keyInfo.type === 'rsa') {
          // modulus (n) -- integer
          if (privKey[i++] !== 0x02)
            throw new Error('Malformed private key (expected integer for n)');
          nLen = privKey[i++];
          if (nLen & 0x80) {
            octets = nLen & 0x7F;
            nLen = 0;
            while (octets > 0) {
              nLen += (privKey[i++] * Math.pow(2, (octets - 1) * 8));
              --octets;
            }
          }
          nStart = i;
          i += nLen;

          // public exponent (e) -- integer
          if (privKey[i++] !== 0x02)
            throw new Error('Malformed private key (expected integer for e)');
          eLen = privKey[i++];
          if (eLen & 0x80) {
            octets = eLen & 0x7F;
            eLen = 0;
            while (octets > 0) {
              eLen += (privKey[i++] * Math.pow(2, (octets - 1) * 8));
              --octets;
            }
          }
          eStart = i;
        } else { // DSA
          // prime (p) -- integer
          if (privKey[i++] !== 0x02)
            throw new Error('Malformed private key (expected integer for p)');
          pLen = privKey[i++];
          if (pLen & 0x80) {
            octets = pLen & 0x7F;
            pLen = 0;
            while (octets > 0) {
              pLen += (privKey[i++] * Math.pow(2, (octets - 1) * 8));
              --octets;
            }
          }
          pStart = i;
          i += pLen;

          // group order (q) -- integer
          if (privKey[i++] !== 0x02)
            throw new Error('Malformed private key (expected integer for q)');
          qLen = privKey[i++];
          if (qLen & 0x80) {
            octets = qLen & 0x7F;
            qLen = 0;
            while (octets > 0) {
              qLen += (privKey[i++] * Math.pow(2, (octets - 1) * 8));
              --octets;
            }
          }
          qStart = i;
          i += qLen;

          // group generator (g) -- integer
          if (privKey[i++] !== 0x02)
            throw new Error('Malformed private key (expected integer for g)');
          gLen = privKey[i++];
          if (gLen & 0x80) {
            octets = gLen & 0x7F;
            gLen = 0;
            while (octets > 0) {
              gLen += (privKey[i++] * Math.pow(2, (octets - 1) * 8));
              --octets;
            }
          }
          gStart = i;
          i += gLen;

          // public key value (y) -- integer
          if (privKey[i++] !== 0x02)
            throw new Error('Malformed private key (expected integer for y)');
          yLen = privKey[i++];
          if (yLen & 0x80) {
            octets = yLen & 0x7F;
            yLen = 0;
            while (octets > 0) {
              yLen += (privKey[i++] * Math.pow(2, (octets - 1) * 8));
              --octets;
            }
          }
          yStart = i;
          i += yLen;
        }

        p = 4 + 7;

        if (keyInfo.type === 'rsa') {
          publicKey = new Buffer(4 + 7 // ssh-rsa
                                 + 4 + nLen
                                 + 4 + eLen);

          publicKey.writeUInt32BE(7, 0, true);
          publicKey.write('ssh-rsa', 4, 7, 'ascii');

          publicKey.writeUInt32BE(eLen, p, true);
          privKey.copy(publicKey, p += 4, eStart, eStart + eLen);

          publicKey.writeUInt32BE(nLen, p += eLen, true);
          privKey.copy(publicKey, p += 4, nStart, nStart + nLen);
        } else { // DSA
          publicKey = new Buffer(4 + 7 // ssh-dss
                                 + 4 + pLen
                                 + 4 + qLen
                                 + 4 + gLen
                                 + 4 + yLen);

          publicKey.writeUInt32BE(7, 0, true);
          publicKey.write('ssh-dss', 4, 7, 'ascii');

          publicKey.writeUInt32BE(pLen, p, true);
          privKey.copy(publicKey, p += 4, pStart, pStart + pLen);

          publicKey.writeUInt32BE(qLen, p += pLen, true);
          privKey.copy(publicKey, p += 4, qStart, qStart + qLen);

          publicKey.writeUInt32BE(gLen, p += qLen, true);
          privKey.copy(publicKey, p += 4, gStart, gStart + gLen);

          publicKey.writeUInt32BE(yLen, p += gLen, true);
          privKey.copy(publicKey, p += 4, yStart, yStart + yLen);
        }
      } else
        throw new Error('Malformed private key (expected sequence)');
    } else if (keyInfo.public)
      publicKey = keyInfo.public;
    else
      throw new Error('Missing data generated by parseKey()');

    // generate a public key format for use with OpenSSL

    p = 4 + 7;

    var asnWriter = new Ber.Writer();
    asnWriter.startSequence();
    if (keyInfo.type === 'rsa') {
      eLen = publicKey.readUInt32BE(p, true);
      p += 4;
      eStart = p;
      p += eLen;

      nLen = publicKey.readUInt32BE(p, true);
      p += 4;
      nStart = p;

      var e = publicKey.slice(eStart, eStart + eLen),
          n = publicKey.slice(nStart, nStart + nLen);
      asnWriter.startSequence();
      asnWriter.writeOID('1.2.840.113549.1.1.1');
      asnWriter.writeNull();
      asnWriter.endSequence();

      asnWriter.startSequence(Ber.BitString);
      asnWriter.writeByte(0x00);
      asnWriter.startSequence();
      asnWriter.writeBuffer(n, Ber.Integer);
      asnWriter.writeBuffer(e, Ber.Integer);
      asnWriter.endSequence();
      asnWriter.endSequence();
    } else {
      pLen = publicKey.readUInt32BE(p, true);
      p += 4;
      pStart = p;
      p += pLen;

      qLen = publicKey.readUInt32BE(p, true);
      p += 4;
      qStart = p;
      p += qLen;

      gLen = publicKey.readUInt32BE(p, true);
      p += 4;
      gStart = p;
      p += gLen;

      yLen = publicKey.readUInt32BE(p, true);
      p += 4;
      yStart = p;

      p = publicKey.slice(pStart, pStart + pLen);
      var q = publicKey.slice(qStart, qStart + qLen),
          g = publicKey.slice(gStart, gStart + gLen),
          y = publicKey.slice(yStart, yStart + yLen);

      asnWriter.startSequence();
      asnWriter.writeOID('1.2.840.10040.4.1');
      asnWriter.startSequence();
      asnWriter.writeBuffer(p, Ber.Integer);
      asnWriter.writeBuffer(q, Ber.Integer);
      asnWriter.writeBuffer(g, Ber.Integer);
      asnWriter.endSequence();
      asnWriter.endSequence();

      asnWriter.startSequence(Ber.BitString);
      asnWriter.writeByte(0x00);
      asnWriter.writeBuffer(y, Ber.Integer);
      asnWriter.endSequence();
    }
    asnWriter.endSequence();

    var b64key = asnWriter.buffer.toString('base64').replace(RE_KEY_LEN, '$1\n'),
        fullkey = '-----BEGIN PUBLIC KEY-----\n'
                  + b64key
                  + (b64key[b64key.length - 1] === '\n' ? '' : '\n')
                  + '-----END PUBLIC KEY-----';

    return {
      type: keyInfo.type,
      fulltype: 'ssh-' + keyInfo.type,
      public: publicKey,
      publicOrig: fullkey
    };
    //privKeyInfo.public = publicKey;
  }
};
