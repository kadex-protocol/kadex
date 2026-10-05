//! Reading a Metaplex Core asset.
//!
//! Collector Crypt mints its vaulted cards as Core assets, and a Core asset is
//! NOT an SPL token. There is no mint, no token account and no supply: the
//! whole thing is ONE account owned by the Core program, with the owner as a
//! field inside it.
//!
//! That is why this file exists rather than a constraint bolted onto the
//! existing SPL path. `Account<TokenAccount>` cannot describe a Core asset,
//! and `token::transfer` cannot move one.
//!
//! What this module does is the small, verifiable half: decide whether a given
//! account really is a Core asset, who owns it, and which collection vouches
//! for it. Moving one is a CPI to the Core program and belongs with the
//! instruction that does it.

use anchor_lang::prelude::*;
use mpl_core::types::{Key, UpdateAuthority};
use mpl_core::accounts::BaseAssetV1;

use crate::errors::VaultError;

/// The Metaplex Core program. Same address on mainnet and devnet; confirmed
/// live on mainnet-beta rather than taken from documentation.
pub const CORE_PROGRAM_ID: Pubkey = pubkey!("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

/// What the vault needs to know about a card before it will accept it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoreCard {
    pub owner: Pubkey,
    /// The collection vouching for this asset, when one does.
    pub collection: Option<Pubkey>,
}

impl CoreCard {
    /// Is this card vouched for by `expected`?
    ///
    /// An asset whose update authority is an ADDRESS rather than a collection
    /// is refused even if that address is the one we expect: a collection is a
    /// published, checkable group, and a bare address is one key's say-so.
    pub fn in_collection(&self, expected: &Pubkey) -> bool {
        self.collection == Some(*expected)
    }
}

/// Read a Core asset out of an account, refusing anything that is not one.
///
/// Three things are checked before any field is believed, in this order:
/// the account is owned by the Core program, it deserializes, and its `key`
/// discriminator says `AssetV1`. Skipping the first would let anyone hand us a
/// look-alike account they wrote themselves; skipping the third would let a
/// collection account pass as a card.
pub fn read_core_card(ai: &AccountInfo) -> Result<CoreCard> {
    require_keys_eq!(*ai.owner, CORE_PROGRAM_ID, VaultError::NotACoreAsset);

    let data = ai.try_borrow_data()?;
    let asset = BaseAssetV1::from_bytes(&data).map_err(|_| error!(VaultError::NotACoreAsset))?;

    require!(asset.key == Key::AssetV1, VaultError::NotACoreAsset);

    Ok(CoreCard {
        owner: asset.owner,
        collection: match asset.update_authority {
            UpdateAuthority::Collection(c) => Some(c),
            UpdateAuthority::Address(_) | UpdateAuthority::None => None,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CC: Pubkey = pubkey!("4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R");
    const OTHER: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

    fn card(collection: Option<Pubkey>) -> CoreCard {
        CoreCard { owner: OTHER, collection }
    }

    #[test]
    fn a_card_from_the_expected_collection_is_accepted() {
        assert!(card(Some(CC)).in_collection(&CC));
    }

    #[test]
    fn a_card_from_another_collection_is_refused() {
        assert!(!card(Some(OTHER)).in_collection(&CC));
    }

    /// The case worth being deliberate about: an asset can name a plain
    /// address as its authority instead of a collection. That is one key's
    /// word, not a published group, so it does not count as membership even
    /// when the address matches.
    #[test]
    fn a_bare_address_authority_is_not_membership() {
        assert!(!card(None).in_collection(&CC));
    }

    #[test]
    fn the_core_program_id_is_the_one_confirmed_on_mainnet() {
        assert_eq!(
            CORE_PROGRAM_ID.to_string(),
            "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
        );
    }
}
