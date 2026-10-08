import StyledImage from '../StyledImage'
import TextButton from '../TextButton'
import { Oval } from 'react-loader-spinner'
import { publicAsset } from '@/config'

const formatAddress = (address: string) => {
  if (!address) return ''
  const start = address.slice(0, 6)
  const end = address.slice(-4)
  return `${start}...${end}`
}

export default function SBT({
  address,
  buttonText,
  chain,
  onMint,
  onClose,
  isPending = false,
}: {
  address: string
  buttonText: string
  chain: string
  onMint: () => void
  onClose: () => void
  isPending?: boolean
}) {
  return (
    <div className='absolute inset-0 bg-latest-grey-1000 z-20 rounded-lg'>
      <div className='absolute bottom-0 right-0 left-0'>
        <div className='px-2.5 py-3 bg-white rounded-lg'>
          <div className='flex justify-between items-center mx-2.5 py-1'>
            <p className='text-latest-black-300 font-semibold text-16'>
              Clean Hands SBT
            </p>
            <button onClick={onClose} disabled={isPending}>
              <StyledImage
                src={publicAsset('/assets/svg/cross.svg')}
                alt=''
                className='h-[14px] w-[14px] m-[2px]'
              />
            </button>
          </div>
          <div className='mt-4 mx-2.5'>
            <p className='pl-4 text-latest-black-300 text-14 font-medium'>
              {chain} address
            </p>
            <div className='flex gap-2.5 bg-latest-grey-200 p-1 mt-1 rounded-[8px]'>
              <StyledImage
                src={publicAsset('/assets/svg/network.svg')}
                alt=''
                className='h-5 w-5 m-1.5'
              />
              <input
                type='numbers'
                defaultValue={address}
                placeholder='address...'
                readOnly
                className='text-latest-black-300 w-full outline-none bg-latest-grey-200 font-medium text-16'
              />
            </div>
            <p className='mt-2 py-2 px-4 text-latest-red-200 bg-latest-red-300 text-12 font-medium rounded-[8px]'>
              You don&apos;t have an {chain} SBT yet.
              <br /> Get one to unlock {chain} Bridge features.
            </p>
            <div className='mt-4'>
              <TextButton onClick={onMint} disabled={isPending}>
                {isPending ? (
                  <div className='flex justify-center gap-2'>
                    <Oval
                      height='20'
                      width='20'
                      color='#ccc'
                      visible={true}
                      ariaLabel='oval-loading'
                      secondaryColor='#ccc'
                      strokeWidth={6}
                      strokeWidthSecondary={6}
                    />
                    <span>Minting SBT...</span>
                  </div>
                ) : (
                  buttonText
                )}
              </TextButton>
              <p className='mt-4 text-latest-grey-100 text-12 font-medium'>
                You will receive a Clean Hands SBT on {chain} <br />
                at the address {formatAddress(address)}.
              </p>
              <p className='mt-4 text-latest-grey-100 text-12 font-medium'>
                Proceed with caution. You can only do this once.
              </p>
              <div className='flex justify-center gap-2 mt-4'>
                <StyledImage
                  src={publicAsset('/assets/svg/silk0.4.svg')}
                  alt=''
                  className='h-4 w-[14px]'
                />
                <p className='text-12 font-medium text-neutral-600'>
                  {' '}
                  Secured by human.tech
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
