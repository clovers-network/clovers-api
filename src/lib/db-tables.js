import r from 'rethinkdb'
import { events } from '../lib/ethers-utils'

const ZERO = '0000000000000000000000000000000000000000000000000000000000000000'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

module.exports = [
  {
    name: 'clovers',
    index: 'board',
    indexes: [
      [
        'named',
        r.row('name').downcase().ne(r.row('board').downcase())
      ],
      [
        'all-modified',
        [
          r.row('owner').ne(ZERO_ADDRESS),
          r.row('modified')
        ]
      ],
      [
        'all-price',
        [
          r.row('owner').ne(ZERO_ADDRESS),
          r.row('price')
        ]
      ],

      [
        'pending-modified',
        [
          r.row('owner').eq(events.Clovers.address.toLowerCase()).and(
            r.row('price').eq(ZERO).or(
              r.row('price').eq('0')
            )
          ),
          r.row('modified')
        ]
      ],
      [
        'pending-price',
        [
          r.row('owner').eq(events.Clovers.address.toLowerCase()).and(
            r.row('price').eq(ZERO).or(
              r.row('price').eq('0')
            )
          ),
          r.row('price')
        ]
      ],

      [
        'NonSym-modified',
        [
          r.row('symmetries').values().reduce((a, c) => a.add(c)).eq(0).and(
            r.row('owner').ne(ZERO_ADDRESS)
          ),
          r.row('modified')
        ]
      ],
      [
        'NonSym-price',
        [
          r.row('symmetries').values().reduce((a, c) => a.add(c)).eq(0).and(
            r.row('owner').ne(ZERO_ADDRESS)
          ),
          r.row('price')
        ]
      ],
      [
        'Sym-modified',
        [
          r.row('symmetries').values().reduce((a, c) => a.add(c)).gt(0),
          r.row('modified')
        ]
      ],
      [
        'Sym-price',
        [
          r.row('symmetries').values().reduce((a, c) => a.add(c)).gt(0),
          r.row('price')
        ]
      ],
      [
        'RotSym-modified',
        [
          r.row('symmetries')('RotSym').eq(1),
          r.row('modified')
        ]
      ],
      [
        'RotSym-price',
        [
          r.row('symmetries')('RotSym').eq(1),
          r.row('price')
        ]
      ],
      [
        'X0Sym-modified',
        [
          r.row('symmetries')('X0Sym').eq(1),
          r.row('modified')
        ]
      ],
      [
        'X0Sym-price',
        [
          r.row('symmetries')('X0Sym').eq(1),
          r.row('price')
        ]
      ],
      [
        'XYSym-modified',
        [
          r.row('symmetries')('XYSym').eq(1),
          r.row('modified')
        ]
      ],
      [
        'XYSym-price',
        [
          r.row('symmetries')('XYSym').eq(1),
          r.row('price')
        ]
      ],
      [
        'XnYSym-modified',
        [
          r.row('symmetries')('XnYSym').eq(1),
          r.row('modified')
        ]
      ],
      [
        'XnYSym-price',
        [
          r.row('symmetries')('XnYSym').eq(1),
          r.row('price')
        ]
      ],
      [
        'Y0Sym-modified',
        [
          r.row('symmetries')('Y0Sym').eq(1),
          r.row('modified')
        ]
      ],
      [
        'Y0Sym-price',
        [
          r.row('symmetries')('Y0Sym').eq(1),
          r.row('price')
        ]
      ],

      [
        'multi-modified',
        [
          r.branch(
            r.row('owner').eq(ZERO_ADDRESS),
            false,
            r.row('symmetries').values().reduce((a, c) => a.add(c))
          ),
          r.row('modified')
        ]
      ],

      [
        'multi-price',
        [
          r.branch(
            r.row('owner').eq(ZERO_ADDRESS),
            false,
            r.row('symmetries').values().reduce((a, c) => a.add(c))
          ),
          r.row('price')
        ]
      ],

      [
        'market-modified',
        [
          r.row('price').coerceTo('number').ne(0),
          r.row('modified')
        ]
      ],
      [
        'market-price',
        [
          r.row('price').coerceTo('number').ne(0),
          r.row('price')
        ]
      ],

      [
        'owner-modified',
        [
          r.row('owner').downcase(),
          r.row('modified')
        ]
      ],
      [
        'owner-price',
        [
          r.row('owner').downcase(),
          r.row('price')
        ]
      ],

      [
        'commented-modified',
        [
          r.row('commentCount').gt(0),
          r.row('modified')
        ]
      ],
      [
        'commented-price',
        [
          r.row('commentCount').gt(0),
          r.row('price')
        ]
      ],

      [
        'contract-modified',
        [
          r.row('owner').eq(events.Clovers.address.toLowerCase()),
          r.row('modified')
        ]
      ],
      [
        'contract-price',
        [
          r.row('owner').eq(events.Clovers.address.toLowerCase()),
          r.row('price')
        ]
      ],

      [
        'public-modified',
        (doc) => {
          return [
            r.expr([
              events.Clovers.address.toLowerCase(),
              '0x0000000000000000000000000000000000000000'
            ]).contains(doc('owner')).eq(false),
            doc('modified')
          ]
        }
      ],
      [
        'public-price',
        (doc) => {
          return [
            r.expr([
              events.Clovers.address.toLowerCase(),
              '0x0000000000000000000000000000000000000000'
            ]).contains(doc('owner')).eq(false),
            doc('price')
          ]
        }
      ],
      [
        'ownerfilter',
        (doc) => {
          return [
            doc('owner').downcase(),
            r.branch(
              doc('price').ne('0'),
              'forsale',
              false
            )
          ]
        }
      ],
      [
        'ownersym',
        (doc) => {
          return [
            doc('owner').downcase(),
            doc('symmetries').values().reduce((a, c) => a.add(c)).gt(0)
          ]
        }
      ],
      'modified',
      'created',

      // old ones
      [
        'Sym',
        (doc) => {
          return doc('symmetries').values().reduce((a, c) => a.add(c)).gt(0)
        }
      ],
      [
        'RotSym',
        (doc) => {
          return doc('symmetries')('RotSym').eq(1)
        }
      ],
      [
        'X0Sym',
        (doc) => {
          return doc('symmetries')('X0Sym').eq(1)
        }
      ],
      [
        'XYSym',
        (doc) => {
          return doc('symmetries')('XYSym').eq(1)
        }
      ],
      [
        'XnYSym',
        (doc) => {
          return doc('symmetries')('XnYSym').eq(1)
        }
      ],
      [
        'Y0Sym',
        (doc) => {
          return doc('symmetries')('Y0Sym').eq(1)
        }
      ],
      [
        'owner',
        (doc) => {
          return doc('owner').downcase()
        }
      ],
      [
        'all',
        () => true
      ],
      [
        'market',
        (doc) => {
          return doc('price').ne('0')
        }
      ],
      // [
      //   'rft',
      //   (doc) => {
      //     // curation market address
      //     return doc('owner').eq('0x9b8e917d6a511d4a22dcfa668a46b508ac26731e')
      //   }
      // ],
      [
        'public',
        (doc) => {
          return r.expr([
            // clovers and null address
            events.Clovers.address.toLowerCase(),
            '0x0000000000000000000000000000000000000000'
          ]).contains(doc('owner')).eq(false)
        }
      ],
      [
        'contract',
        (doc) => {
          return doc('owner').eq(events.Clovers.address.toLowerCase())
        }
      ],
      [
        'commented',
        (doc) => {
          return doc('commentCount').gt(0)
        }
      ]
    ]
  },
  {
    name: 'users',
    index: 'address',
    indexes: [
      [
        'all-modified',
        [
          r.row('address').ne(ZERO_ADDRESS),
          r.row('modified')
        ]
      ],
      [
        'all-balance',
        [
          r.row('address').ne(ZERO_ADDRESS),
          r.row('balance')
        ]
      ],
      [
        'all-clovers',
        [
          r.row('address').ne(ZERO_ADDRESS),
          r.row('cloverCount')
        ]
      ],
      [
        'all-albums',
        [
          r.row('address').ne(ZERO_ADDRESS),
          r.row('albumCount')
        ]
      ]
    ]
  },
  {
    name: 'chats',
    index: 'id',
    indexes: [
      [
        'board',
        (doc) => {
          return doc('board').downcase()
        }
      ],
      [
        'dates',
        (doc) => {
          return [doc('board'), doc('created')]
        }
      ]
    ]
  },
  {
    name: 'albums',
    index: 'id',
    indexes: [
      [
        'name',
        (doc) => {
          return doc('name').downcase()
        }
      ],
      [
        'userAddress',
        (doc) => {
          return doc('userAddress')
        }
      ],
      [
        'dates',
        (doc) => {
          return [doc('id'), doc('modified')]
        }
      ],
      [
        'cloverCount',
        (doc) => {
          return doc('clovers').count()
        }
      ],
      [
        'all',
        (doc) => {
          return doc('clovers').count().gt(0)
        }
      ],
      [
        'clovers',
        [
          r.row('clovers'),
          { multi: true }
        ]
      ]
    ]
  },
  {
    name: 'logs',
    index: 'id',
    indexes: [
      // updated ones
      [
        'active',
        (doc) => {
          return [
            r.branch(
              // log.name is not in this list
              // if
              r.expr(['ClubToken_Transfer','CurationMarket_Transfer']).contains(doc('name')),
              false,
              // else if
              doc('name').ne('Clovers_Transfer'),
              true,
              // not going to Clovers Contract
              // else if
              doc('data')('_to').downcase().ne(events.Clovers.address.toLowerCase()),
              true,
              // else
              false
            ),
            doc('blockNumber')
          ]
        }
      ],
      [
        'type',
        (doc) => {
          return [
            r.branch(
              r.expr(['ClubTokenController_Buy','ClubTokenController_Sell']).contains(doc('name')),
              'Coin_Activity',
              doc('name')
            ),
            doc('blockNumber')
          ]
        }
      ],
      [
        'clovers',
        (doc) => {
          return [
            r.branch(
              doc.hasFields({ data: 'board' }),
              doc('data')('board').downcase(),
              r.branch(
                doc.hasFields({ data: '_tokenId' }),
                r.branch(
                  doc('name').ne('CurationMarket_Transfer'),
                  doc('data')('_tokenId').downcase(),
                  null
                ),
                null
              )
            ),
            doc('blockNumber')
          ]
        }
      ],
      [
        'unique_log',
        [r.row('transactionHash'), r.row('logIndex')]
      ],
      'blockNumber',

      // older
      'name',
      'userAddresses',
      [
        'activity',
        (doc) => {
          return r.branch(
            // log.name is not in this list
            // if
            r.expr(['ClubToken_Transfer','CurationMarket_Transfer']).contains(doc('name')),
            'priv',
            // else if
            doc('name').ne('Clovers_Transfer'),
            'pub',
            // not going to Clovers Contract
            // else if
            doc('data')('_to').downcase().ne(events.Clovers.address.toLowerCase()),
            'pub',
            // else
            'priv'
          )
        }
      ],
      [
        'clover',
        (doc) => {
          return r.branch(
            doc.hasFields({ data: 'board' }),
            doc('data')('board').downcase(),
            r.branch(
              doc.hasFields({ data: '_tokenId' }),
              r.branch(
                doc('name').ne('CurationMarket_Transfer'),
                doc('data')('_tokenId').downcase(),
                null
              ),
              null
            )
          )
        }
      ]
    ]
  },
  {
    name: 'orders',
    index: 'id',
    indexes: [
      'market',
      [
        'unique_log',
        [r.row('transactionHash'), r.row('logIndex')]
      ]
    ]
  }
]
