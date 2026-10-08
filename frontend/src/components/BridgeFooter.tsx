import React from 'react'
import StyledImage from './StyledImage'
import { publicAsset } from '@/config'

const BridgeFooter: React.FC = () => (
  <div className='flex justify-center gap-2 pb-3'>
    <img
      src={publicAsset('/assets/svg/logo.svg')}
      alt='log'
    />
    <p className='text-12 font-medium text-neutral-600'>
      Secured by human.tech
    </p>
  </div>
)

export default BridgeFooter
